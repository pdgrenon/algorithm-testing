/**
 * The season as a calendar, so a phone shouts before a kickoff does.
 *
 * ── Why this and not a notification ─────────────────────────────────────
 *
 * The most common way to lose a survivor pool is not picking the wrong team.
 * It is not picking. Every other screen in this app is beautiful and inert:
 * the per-game countdown on the Week screen is visible only to somebody who
 * has already opened the app, which is exactly the person who was not going
 * to forget.
 *
 * The obvious fix is a notification, and the obvious fix does not exist. A
 * browser cannot schedule a notification for a future time — the Notification
 * Triggers API was never shipped by anyone — so a web app's only route to
 * "tell me at 12:45 on Sunday" is a push server, which means a server that
 * knows your picks and holds a subscription endpoint for your device. This
 * app's entire posture is that nothing leaves the device: `connect-src 'self'`,
 * every pick in localStorage, an edge proxy that reads ESPN and holds nothing.
 * Push would be the first thing to break that, for a feature the platform
 * already solves.
 *
 * A calendar file solves it exactly. The alarm is scheduled by the calendar
 * app, on the device, offline, by machinery that has been reliable for twenty
 * years — and nothing about your picks reaches anybody.
 *
 * ── On subscribing, which is the thing to be careful about ──────────────
 *
 * A downloaded `.ics` is a snapshot: import it and the events are yours, and
 * next week's changes are not. A *subscribed* calendar (`webcal:`) re-fetches
 * a URL on a schedule and always shows the current answer, which is plainly
 * nicer — and is a different system, not a flag on this one.
 *
 * It needs a per-person URL that a calendar client can fetch unauthenticated,
 * serving that person's picks. That is a server holding pick data, reachable
 * by anyone who learns the URL, forever, with no way to know who fetched it.
 * Every one of those is a property this codebase currently does not have and
 * says out loud that it does not have.
 *
 * It is buildable and the shape is known: a Pages Function at `/api/calendar`
 * keyed by a long random token minted on the device, with the pick log carried
 * in the token's storage rather than in the URL. What it costs is the sentence
 * in the README that says every pick is in your browser. That is a trade worth
 * making deliberately, in its own change, with the README edited in the same
 * commit — not smuggled in behind a download button. So: this file emits the
 * snapshot, and the generator is written so the feed would reuse it whole.
 * `toIcs` is pure and takes its clock as an argument precisely so an edge
 * Function could call it.
 *
 * ── Correctness, which for iCalendar is mostly formatting ───────────────
 *
 * RFC 5545 is unforgiving in ways that fail silently: a calendar that dislikes
 * a file usually imports nothing and says nothing. The three that bite:
 *
 *   CRLF        every line, including the last. LF-only files are rejected
 *               by Outlook and accepted by everything else, which is the
 *               worst of both worlds because it works while you test it.
 *   Folding     no line over 75 octets. **Octets, not characters** — fold by
 *               character count and a team name with an accent in it splits a
 *               UTF-8 sequence down the middle.
 *   Escaping    backslash, semicolon and comma are escaped inside TEXT, and
 *               a colon is not. Escaping the colon is the common overreach
 *               and it corrupts every DESCRIPTION containing a time.
 *
 * All three are tested in test/calendar.test.js rather than trusted.
 */

/** Product id. Not a URL — see the origin check in scripts/check-shipped.mjs. */
const PRODID = '-//averageideas//Deadpool//EN';

/** A regular-season game, near enough, for an event that needs an end. */
const GAME_MINUTES = 190;

/** How long the "you have not picked" window is drawn as. */
const DEADLINE_MINUTES = 30;

/**
 * When to shout, in minutes before the event.
 *
 * Two, deliberately. The day-before one is what gets a pick made at all; the
 * ninety-minute one is the backstop for somebody who saw the first, thought
 * "later", and did what everybody does with later. One alarm reliably produces
 * one of those two failures.
 */
export const DEFAULT_ALARMS = Object.freeze([1440, 90]);

/* ------------------------------------------------------------ formatting -- */

/** A Date to iCalendar UTC: 20260913T170000Z. */
export function icsStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * Escape a TEXT value per RFC 5545 §3.3.11.
 *
 * Backslash first, or every escape this function adds gets escaped again by
 * its own later passes. The colon is deliberately absent: §3.3.11 lists
 * backslash, semicolon, comma and newline, and nothing else. Escaping a colon
 * is legal to *parse* but wrong to emit, and it shows up as a literal `\:` in
 * the middle of every description a client renders.
 */
export const escapeText = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n');

/**
 * Fold one content line to 75 octets, continuing with a leading space.
 *
 * Measured in UTF-8 octets, which is what the spec says and is not the same as
 * characters the moment anything is not ASCII. A multi-byte character is never
 * split: the fold falls before it, so a short line is emitted rather than a
 * broken sequence. An entry named by a person is exactly where this arises —
 * "Ognjen's Revenge" is fine, an em dash or an accent is not.
 */
export function foldLine(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;

  const chars = [...line];
  const out = [];
  let current = '';
  let width = 0;
  // 75 for the first line; a continuation spends one octet on its leading space.
  let limit = 75;

  for (const ch of chars) {
    const size = new TextEncoder().encode(ch).length;
    if (width + size > limit) {
      out.push(current);
      current = ch;
      width = size;
      limit = 74;
    } else {
      current += ch;
      width += size;
    }
  }
  if (current) out.push(current);
  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n');
}

/* --------------------------------------------------------------- planning -- */

/**
 * What deserves a calendar entry this season, and what each one should say.
 *
 * Separated from the serialiser because they fail differently and are worth
 * testing apart: this decides policy, `toIcs` only has to be RFC-correct.
 *
 * Three kinds, and the middle one is the whole point of the feature:
 *
 *   `pick`      a pick already recorded for a game that has not kicked off.
 *               One short alarm — you have decided, this is a reminder of
 *               what you decided.
 *   `deadline`  an entry with no pick for a week that is still open. Both
 *               alarms, and the recommendation in the body, so the reminder
 *               itself carries the answer rather than sending you to an app.
 *   `played`    a pick whose game has kicked off. No alarm: it is a record,
 *               and an alarm about a decision nobody can change any more is
 *               the kind of notification that gets an app muted.
 *
 * An eliminated entry gets nothing at all. Reminding somebody to make a pick
 * they are not allowed to make is worse than silence.
 */
export function planReminders({
  season,
  week = null,
  entries = [],
  picks = [],
  games = [],
  statuses = {},
  recommendations = {},
  alarms = DEFAULT_ALARMS,
  now = null,
} = {}) {
  const at = now instanceof Date ? now.getTime() : (now ?? 0);
  const out = [];

  for (const pick of picks) {
    if (season !== undefined && season !== null && pick.season !== season) continue;
    const entry = entries.find((e) => e.id === pick.entry);
    const startsAt = pick.startDate ? Date.parse(pick.startDate) : NaN;
    // A pick with no kickoff on it cannot be placed on a calendar. Dropped
    // rather than defaulted to now, which would put a phantom alarm on today.
    if (!Number.isFinite(startsAt)) continue;

    const played = startsAt <= at;
    out.push({
      uid: `${pick.season}-w${pick.week}-${pick.entry}-pick`,
      kind: played ? 'played' : 'pick',
      entryId: pick.entry,
      week: pick.week,
      startsAt,
      endsAt: startsAt + GAME_MINUTES * 60_000,
      title: `${entry?.name ?? pick.entry} · ${pick.team}${pick.opponent ? ` vs ${pick.opponent}` : ''}`,
      description: describePick(pick, played),
      alarms: played ? [] : [Math.min(...alarms)],
    });
  }

  // The deadline, per entry, for the week on the board. Only for an entry that
  // is alive and has not picked — the two conditions that make a reminder
  // actionable rather than noise.
  //
  // ── Retracting one, which an export has to do explicitly ────────────────
  //
  // An entry that has since picked simply stopped being emitted here, and that
  // is not enough. **An .ics import adds and updates; it never deletes.** So a
  // file exported on Tuesday put "pick due — week 5" in the calendar, and
  // re-exporting after picking on Saturday left the Tuesday copy sitting there
  // with its ninety-minute alarm intact — firing on Sunday to tell somebody to
  // make a pick they had already made. An app that cries wolf gets muted, and
  // a muted app does not remind you the week it matters.
  //
  // So the event is emitted with STATUS:CANCELLED and a bumped SEQUENCE
  // instead, which is how RFC 5545 retracts something: same UID, higher
  // sequence, and a compliant client removes it. It costs a few lines in the
  // file and nothing on screen.
  //
  // A *subscribed* feed has none of this to do — it is replaced wholesale on
  // each refresh, so an event that stops being served simply disappears. That
  // is a real thing the feed does that a download cannot.
  const firstKickoff = earliestKickoff(games, at);
  if (week !== null && firstKickoff !== null) {
    for (const entry of entries) {
      const status = statuses[entry.id];
      const eliminated = Boolean(status && status.alive === false);
      const alreadyPicked = picks.some(
        (p) => p.entry === entry.id && p.week === week && p.season === season,
      );

      if (eliminated || alreadyPicked) {
        out.push({
          uid: `${season}-w${week}-${entry.id}-due`,
          kind: 'deadline',
          entryId: entry.id,
          week,
          startsAt: firstKickoff,
          endsAt: firstKickoff + DEADLINE_MINUTES * 60_000,
          title: `${entry.name} · pick due — week ${week}`,
          description: alreadyPicked
            ? `${entry.name} has picked for week ${week}. This reminder is retracted.`
            : `${entry.name} is out. This reminder is retracted.`,
          alarms: [],
          cancelled: true,
        });
        continue;
      }

      const suggestion = recommendations[entry.id] ?? null;
      out.push({
        uid: `${season}-w${week}-${entry.id}-due`,
        kind: 'deadline',
        entryId: entry.id,
        week,
        startsAt: firstKickoff,
        endsAt: firstKickoff + DEADLINE_MINUTES * 60_000,
        title: `${entry.name} · pick due — week ${week}`,
        description: describeDeadline(entry, week, suggestion),
        alarms: [...alarms],
      });
    }
  }

  return out.sort((a, b) => a.startsAt - b.startsAt || (a.uid < b.uid ? -1 : 1));
}

/** The first kickoff still ahead of us, which is when the week really closes. */
function earliestKickoff(games, at) {
  const times = games
    .filter((g) => !g.state || g.state === 'pre')
    .map((g) => Date.parse(g.startDate))
    .filter((t) => Number.isFinite(t) && t > at);
  return times.length ? Math.min(...times) : null;
}

function describePick(pick, played) {
  const parts = [`Week ${pick.week}: ${pick.team}${pick.opponent ? ` vs ${pick.opponent}` : ''}.`];
  if (pick.snapshot?.winPct !== undefined && pick.snapshot?.winPct !== null) {
    parts.push(`${pick.snapshot.winPct.toFixed(1)}% to advance when picked.`);
  }
  if (pick.strategyId) parts.push(`Chosen by ${pick.strategyId}.`);
  if (played) parts.push(`Recorded result: ${pick.result}.`);
  return parts.join(' ');
}

/**
 * The body of a "you have not picked" reminder.
 *
 * The recommendation goes in it, which is the point the whole feature turns
 * on: an alarm that says "open the app" competes with everything else on a
 * Sunday morning. One that says "take Kansas City" has already done the job.
 *
 * It is stamped as of when the file was made, and says so. A recommendation is
 * a snapshot of a board that keeps moving, and a calendar entry written on
 * Tuesday quoting Sunday's odds without qualification would be the exact
 * quiet-wrongness this codebase organises itself against.
 */
function describeDeadline(entry, week, suggestion) {
  if (!suggestion) {
    return `No pick recorded for ${entry.name} in week ${week}. Open Deadpool to make one before kickoff.`;
  }
  const pct = suggestion.winPct !== undefined && suggestion.winPct !== null
    ? ` (${suggestion.winPct.toFixed(1)}% to advance)` : '';
  const est = suggestion.winPctSource === 'spread_estimate' ? ' Estimated from the spread rather than a published price.' : '';
  return `No pick recorded for ${entry.name} in week ${week}. `
    + `Suggested: ${suggestion.teamAbbreviation}${suggestion.opponentAbbreviation ? ` vs ${suggestion.opponentAbbreviation}` : ''}${pct}.`
    + `${est} As of when this calendar was exported — check the app if the board has moved.`;
}

/* ------------------------------------------------------------- serialising -- */

/**
 * Reminders to an iCalendar document.
 *
 * Pure, and takes `now` rather than reading a clock, for the same reason every
 * strategy does: a function that stamps itself cannot be tested against a
 * fixture, and this one would be untestable in exactly the part that is easy
 * to get wrong. It is also what would let an edge Function serve the same
 * bytes if the subscription feed described at the top is ever built.
 */
export function toIcs(reminders, { now = new Date(0), calendarName = 'Deadpool', sequence = 0 } = {}) {
  const stamp = icsStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    // Clients that honour it stop polling a snapshot every five minutes. It is
    // a hint and half of them ignore it, which costs nothing either way.
    'X-PUBLISHED-TTL:PT12H',
  ];

  for (const r of reminders) {
    const start = icsStamp(new Date(r.startsAt));
    const end = icsStamp(new Date(r.endsAt));
    if (!start || !end) continue;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.uid}@deadpool.averageideas.dev`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeText(r.title)}`,
      `DESCRIPTION:${escapeText(r.description)}`,
      // Free rather than busy: these are markers, and a survivor pick should
      // not make somebody look unavailable for three hours every Sunday.
      'TRANSP:TRANSPARENT',
      `CATEGORIES:${escapeText(r.kind === 'deadline' ? 'Deadline' : 'Pick')}`,
    );

    // SEQUENCE on every event, not just the retractions.
    //
    // A retraction needs a higher sequence than the event it retracts, which
    // is why it was here. But an *absent* SEQUENCE means 0 (RFC 5545 §3.8.7.4),
    // so emitting it only on cancellation made the ladder one-way: export a
    // live reminder (0), pick, export the retraction (1) — and then clear the
    // pick and the reminder comes back at 0 against a stored 1. RFC 5546
    // §3.2.2 says a client does not apply that, so the event stays cancelled
    // and the phone stays quiet on the week it matters. Nothing looks wrong:
    // the .ics is well-formed and the import succeeds.
    //
    // One number for the whole export, bumped by the caller each time it
    // exports. Sequence is per-UID, so sharing a value across events is fine,
    // and "strictly newer than the last file this device wrote" is the
    // property that actually has to hold — which no pure function of the
    // current state can give, because picking and clearing is a cycle.
    lines.push(`SEQUENCE:${Number.isInteger(sequence) && sequence > 0 ? sequence : 0}`);
    if (r.cancelled) lines.push('STATUS:CANCELLED');

    for (const minutes of r.alarms ?? []) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `TRIGGER:-PT${minutes}M`,
        `DESCRIPTION:${escapeText(r.title)}`,
        'END:VALARM',
      );
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  // A trailing CRLF, because the last line is a content line like any other
  // and a file ending without one is malformed however well it happens to read.
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** What to call the downloaded file. */
export const icsFilename = (season) => `deadpool-${season}.ics`;

/* ------------------------------------------------- the subscribable feed -- */

/**
 * Every remaining week's lock time, as events anybody can subscribe to.
 *
 * ── Why this exists next to planReminders, rather than replacing it ──────
 *
 * `planReminders` above builds a *snapshot* of your season: your picks, your
 * unpicked weeks, and the strategy's current recommendation. It is personal,
 * and it is frozen at the moment you export it.
 *
 * This builds the opposite: no picks, no recommendation, nobody's inventory —
 * only when each week closes. That is what makes it servable from an edge
 * Function and subscribable at a URL, and the two properties that follow are
 * the whole argument for it.
 *
 * **It cannot go stale.** Kickoff times are known months ahead. A feed of
 * "Week 7 locks at 17:00Z" is as correct in April as on the morning, so the
 * calendar client's refresh interval — which is hours to a day, and which
 * nothing on this end controls — does not matter.
 *
 * **It needs nothing about you.** No token, no upload, no stored pick log. One
 * URL serves every person in every pool, cached at the edge like the schedule
 * it is derived from.
 *
 * ── It is a redirect, and that is the whole specification ───────────────
 *
 * Not a compromise reached by subtracting things that were too hard. It is
 * what a calendar reminder is *for*: it fires at the right moment and is read
 * in two seconds. That is exactly enough to say "this closes now, go and look"
 * and nowhere near enough to carry anything somebody might act on.
 *
 * Three attempts to put more in it were considered and all three fail, for
 * reasons worth keeping so nobody re-derives them:
 *
 * **Your pick, in a subscribed feed.** Needs your inventory. Your inventory
 * changes weekly and a subscription URL is fixed forever, so this requires a
 * server that stores and updates your pick log — reachable by anyone who
 * learns the URL. That is the local-first property, spent.
 *
 * **A recommendation, even a stale one.** Decays in hours; a client refreshes
 * on its own schedule, hours to a day, uncontrollable. It would show
 * Wednesday's answer on Sunday morning with nothing marking it aged.
 *
 * **The board's biggest favourites**, which needs nothing personal and was
 * briefly here. It had to be followed by a sentence explaining that it could
 * not know which of them you had already spent — and content that must be
 * immediately qualified into uselessness should not be there. It read as
 * advice and was not advice.
 *
 * Everything the app knows is one tap away and correct. A reminder that
 * competes with it can only ever be a staler copy.
 */
export function planSeasonDeadlines({
  season,
  weeks = {},
  alarms = DEFAULT_ALARMS,
  now = null,
} = {}) {
  const at = now instanceof Date ? now.getTime() : (now ?? 0);
  const out = [];

  for (const key of Object.keys(weeks).map(Number).sort((a, b) => a - b)) {
    const games = weeks[key] ?? [];
    const upcoming = games
      .filter((g) => (!g.state || g.state === 'pre') && g.startDate)
      .map((g) => ({ at: Date.parse(g.startDate), game: g }))
      .filter((x) => Number.isFinite(x.at) && x.at > at)
      .sort((a, b) => a.at - b.at);
    if (!upcoming.length) continue;

    const startsAt = upcoming[0].at;
    out.push({
      uid: `${season}-w${key}-lock`,
      kind: 'deadline',
      week: key,
      startsAt,
      endsAt: startsAt + DEADLINE_MINUTES * 60_000,
      title: `Survivor pick due — week ${key}`,
      description: describeLock(key),
      alarms: [...alarms],
    });
  }

  return out;
}

/**
 * What a lock reminder says: that the week is closing, and where to go.
 *
 * ── Why there is nothing else in it ─────────────────────────────────────
 *
 * There was, briefly. This listed the board's biggest favourites, with a
 * sentence explaining that it could not know which of them you had already
 * spent. That sentence is the tell: a line of content that has to be
 * immediately qualified into uselessness is content that should not be there.
 * It read as advice, it was not advice, and the only thing standing between
 * the two was a disclaimer nobody reads on a phone at 12:45.
 *
 * A calendar reminder is a good alarm clock and a bad newspaper. It fires at
 * the right moment and is read in two seconds, which is exactly enough to say
 * "this closes now, go and look" and nowhere near enough to carry a number
 * somebody might act on. Everything the app knows — your inventory, the live
 * board, what the strategy actually recommends — is one tap away and correct,
 * and a reminder that competes with it can only ever be a staler copy.
 *
 * So the feed redirects, and holds nothing that could be wrong.
 */
function describeLock(week) {
  return `Week ${week} closes at the first kickoff. Open Deadpool to make your pick.`;
}
