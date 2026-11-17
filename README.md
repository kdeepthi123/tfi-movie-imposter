# 🎬 TFI Movie Imposter

A phone-friendly multiplayer party game: everyone gets the same secret word except one hidden **imposter**. Give clues, vote, catch the imposter, and if they're caught they get one guess at the word to steal the win.

**▶ Play now: https://tfi-movie-imposter.kondavitideepthi.workers.dev**

- **Any topic**: the host types a topic (e.g. *Cities in AP & Telangana*, *Telugu comedians*, *Jobs*) and free Cloudflare AI generates about 40 words for it (takes ~40 seconds). *Telugu movies* is built in and needs no AI.
- **20 possible answers** each round: the real one plus 19 look-alikes, so it's hard for the imposter
- **Poster / picture mode** (optional): the 20 options show pictures instead of names. Telugu movies use posters listed in `src/posters.js`; AI topics get Wikipedia lead images, looked up when the topic is created (about a second). The toggle appears when at least 60% of a topic's words have a picture; words without one show their name.
- **✓ / ✗ marks**: tap an option to mark it possible or ruled out (private to each player), handy for the imposter to narrow it down.
- **Clue timer**: 5 minutes by default (host can pick Off/2/3/5/7/10, or add a minute). Voting opens automatically when time runs out.

- 3–10 players (5 is ideal), each on their own phone
- No accounts, no Firebase. Runs entirely on Cloudflare (free tier)
- The server keeps all secrets, and each phone only receives its own card, so nobody can find the imposter by inspecting the page
- Players can lock their phone or refresh and they'll rejoin automatically

## Run locally

```bash
npm install
npm run dev        # http://127.0.0.1:8787
```

Open it in several browser tabs to play against yourself.

## AI topics

AI topics use **Cloudflare Workers AI** (model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) through the `AI` binding in `wrangler.jsonc`. It runs on your Cloudflare account's free daily allowance (roughly a dozen or more topics per day), so there's no key and no bill. If the day's allowance runs out, the game tells the host and keeps the current topic.

Optional: to use Claude instead (better word quality, needs credits on platform.claude.com):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

then add `"vars": { "AI_PROVIDER": "claude" }` to `wrangler.jsonc` and run `npm run deploy`.

## Publish it (free)

```bash
npx wrangler login     # opens the browser to sign in to your Cloudflare account
npm run deploy
```

Wrangler prints your URL, e.g. `https://tfi-movie-imposter.<your-subdomain>.workers.dev`. Share that link with friends. The room code is also a share button that sends `…/?room=123456`.

## Files

| File | What it is |
| --- | --- |
| `public/` | The website (HTML/CSS/JS, no build step) |
| `src/worker.js` | API + one Durable Object per room (game rules, voting, scoring) |
| `src/movies.js` | Built-in Telugu movie list. Add your favourites here |
| `src/topics.js` | AI topic generation (Workers AI, optional Claude) and the look-alike picker |
| `wrangler.jsonc` | Cloudflare config |

## Rules / scoring

1. The host picks a topic and starts a round. Everyone taps to reveal their card privately. Below it, everyone sees the same 20 possible answers (the real one plus 19 look-alikes that share attributes like hero, director, region or genre).
2. Starting with the announced player, each person gives one clue. The clue timer runs (5 min by default).
3. Voting opens when the host taps it or the timer runs out. Votes are secret until everyone has voted (host can force a reveal).
4. Most votes on the imposter means they're caught and get one guess from the 20 possible answers. A wrong guess means the crew wins; a right guess means the imposter steals it.
5. Wrong person voted out, or a tie, means the imposter wins.
6. Crew win: +1 per crew member. Imposter win: +2.

Rooms auto-delete after 24 hours of inactivity. Words don't repeat within a topic until its list runs out. The host can change the topic between rounds.
