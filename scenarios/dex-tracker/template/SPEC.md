# Dex Tracker app specification

Build Dex Tracker: a dashboard for a Pokémon completionist named Robin, who plays every
game, trades with friends and hunts shiny Pokémon. It tracks what Robin has caught, what's
still missing and how to get it. The data comes from the Dex Tracker API in this repo,
which another team maintains. The framework you must use is named in your instructions.
Everything else (libraries, rendering strategy, routing, data fetching, state management,
project structure) is up to you.

Work autonomously until `npm test` passes. Don't stop to ask questions; where this spec
is silent, make a reasonable choice.

## Repository layout

| Path | What it is | May you change it? |
| --- | --- | --- |
| `app/` | **Your app.** Create it. | Yes |
| `api/server.mjs` | The Dex Tracker API | No |
| `api/openapi.json` | The API's documentation (OpenAPI 3.1) | No |
| `data/` | The API's database and images | No |
| `tests/` | Acceptance tests | No |
| `design/` | `tokens.css` and reference screenshots | No |

Your work is judged from `app/` only. The harness runs its own copies of `api/`, `data/`,
`tests/` and `design/`, so changes to them have no effect.

## How the app is run

`app/package.json` must define:

- `npm run build`: produce a production build. If your app has no build step, this can be a no-op.
- `npm start`: serve the production build (not a dev server) on port `$PORT` (default `3000`).

Both commands receive `API_BASE_URL` (default `http://localhost:9000`), the origin of the
API. The browser can reach the API at that same URL. Run `npm install` in `app/`
before either command; the harness does the same.

In production a reverse proxy sits in front of your server and handles HTTPS, HTTP/2 and
compression. Don't implement any of those. The proxy's host name isn't known in advance,
so the server must answer requests for any `Host` header.

## The API

Start it with `npm run api` from the repo root. It listens on `http://localhost:9000`.
`api/openapi.json` documents every endpoint and response; it's also served at
`/api/openapi.json`. In short:

| Endpoint | What it returns |
| --- | --- |
| `GET /api/me` | Robin's totals (species caught, shinies, trades, hours played, …) and the data's current date |
| `GET /api/meta` | Generations, types, every game, catch methods: lists for filters and forms |
| `GET /api/stats/completion-by-game`, `/api/stats/catches-by-month` | Chart data for the overview |
| `GET /api/activity` | Recent trades, catches and finished shiny hunts |
| `GET /api/needs` | Species Robin has never caught, with how to get each one |
| `GET /api/species`, `/api/species/{name}`, `/api/species/{name}/catches` | Species search, one species with Robin's progress, its catches |
| `GET /api/catches` | Every catch, filtered, sorted and paged |
| `GET /api/games`, `/api/games/{id}`, `/api/games/{id}/dex` | Owned games, one game, its regional Pokédex |
| `GET /api/friends`, `/api/friends/{id}` | Friends, one friend |
| `GET`/`POST /api/trades`, `GET /api/trades/{id}` | Trades; log a new one |
| `GET /api/hunts`, `/api/hunts/{id}`, `POST /api/hunts/{id}/encounters` | Shiny hunts; count encounters |
| `GET /media/...` | Sprites and artwork (absolute URLs to them are in responses) |

- Every `/api` response takes about 30 ms, like a real service.
- **The app must get all of its data from the API over HTTP at request time.** Don't read
  `data/`, and don't fetch, prerender or embed API data at build time. Treat the API as a
  live service whose data can change at any moment, including through the app's own
  writes. You may cache responses in memory at runtime, but after the app writes
  something (a trade, an encounter), every page must show the change.
- The tests enforce this: they build your app against the normal API, then run it against
  an API whose data has changed (`tests/fixtures/live-data.sql`). They also write through
  the API and check that the app shows the result.
- You may read files under `data/` while developing, to learn the data's shape.

## Conventions

- **Numbers** use en-US digit grouping: `71,859`.
- **Dates** are shown as the API gives them: `2026-10-15`.
- **Percentages** have one decimal and a `%` sign: `96.0%`.
- **Dex number**: the species ID as `#` plus four zero-padded digits (`#0025`).
- **Names**: show the API's `displayName` for species and games, `name` for friends, and
  `displayName` for types and generations. URLs use the API's names and ids:
  `/pokemon/mr-mime`, `/games/lets-go-pikachu`, `/friends/12`.
- **Missing values** (a ball for a traded Pokémon, a date that's `null`) are shown as `—` (em dash).
- **Yes/no values** in tables are shown as `Yes` or `No`.

## Every page

- `<html lang="en">`.
- A `banner` landmark containing a link named `Dex Tracker` to `/`, and a `navigation`
  landmark with these links, in this order: `Overview` (`/`), `Needs` (`/needs`), `Catches`
  (`/catches`), `Games` (`/games`), `Friends` (`/friends`), `Trades` (`/trades`),
  `Hunts` (`/hunts`).
- One `main` landmark containing exactly one `h1`.
- A `contentinfo` landmark with the text: `Dex Tracker is a fan project. Pokémon and
  Pokémon character names are trademarks of Nintendo.`
- The document title is `<h1 text> – Dex Tracker` (an en dash with spaces around it).
  The overview's title is just `Dex Tracker`.
- **Navigation**: following any link between pages must count as a navigation in
  Chrome. Either it loads a new document, or it's a client-side navigation that Chrome's
  [Soft Navigations API](https://developer.chrome.com/docs/web-platform/soft-navigations)
  detects: the click changes the URL through the History or Navigation API, and then new
  content is painted. The tests check this for several links.
- Any URL loaded directly (a deep link, or a reload) shows the same page as navigating to it.

### Building blocks

- A **section** is an element with the `region` role whose accessible name is its heading,
  for example `<section aria-labelledby="needs-heading">` containing
  `<h2 id="needs-heading">Needs</h2>`.
- A **Pokémon link** is a link to `/pokemon/<species name>` whose accessible name is the
  species' `displayName`. Where a table column is named `Pokémon`, the cell has the
  species' sprite (an `<img>` with empty alt text) followed by its Pokémon link.
- A **game link** is a link to `/games/<game id>` named with the game's `displayName`; a
  **friend link** goes to `/friends/<id>`, named with the friend's name.
- A **data table** is a `table` with a column header (`th`) per column, in the order given,
  and one row per item. Its accessible name is given for each table (use `<caption>` or
  `aria-label`).
- **Pagination**, where a page says a list is paged: below the table, the text
  `Page <n> of <total pages>` plus links named `Previous page` and `Next page` to the
  neighbouring pages. Leave out `Previous page` on the first page and `Next page` on the
  last (the text stays, even as `Page 1 of 1`). The page number is in the URL query as
  `page` (1-based, omitted for page 1).
- **Filters** are native form controls with visible labels. Their state lives in the URL
  query, under the API's parameter names and values (`?source=wild&generation=generation-i`).
  Changing a filter updates the URL (pushing or replacing a history entry) and goes back
  to page 1, without needing a submit button. Omit parameters that are empty or at their
  default. Loading a URL with filters in it shows that filtered view.

### Charts

The overview, game and friend pages have charts. Draw them yourself as inline SVG, with
your framework's templates or your own code. **Don't use charting libraries, canvas or
images.** They're simple on purpose:

- A **bar chart** has one horizontal bar per item, top to bottom in the data's order, with
  each item's label to the left of its bar. A **column chart** has one vertical column per
  item, left to right in time order, with the labels below.
- The chart is an `<svg>` element with `role="img"` whose accessible name is the chart's
  title. Assistive technology doesn't see inside an element with `role="img"`, so labels
  that are links must be outside the `<svg>` (for example, an HTML list laid out beside it).
- Each item is drawn as exactly one `<rect>`, with a `<title>` child reading
  `<label>: <value>` (`Red: 96.0%`, `2026-10: 646`), formatted per the conventions.
  Other shapes (axes, gridlines, backgrounds) are fine but mustn't be `<rect>`s with a
  `<title>`.
- Bars and columns share a zero baseline, and their length (width for bars, height for
  columns) is proportional to the value: the largest value gets the full length, and a
  zero value gets zero length (its `<rect>` is still there). Within 1 px.
- Every chart has a **data table** with the same items, named `<chart title> data`. It
  can be visible or visually hidden, but it must stay in the accessibility tree: no
  `display: none`, `hidden` or collapsed `<details>`.
- Use the chart colors in `design/tokens.css`. No animations.

## Pages

### `/` – Overview

- `h1`: `Overview`. Title: `Dex Tracker`.
- Section `Summary`: a description list with these terms and values from `/api/me`, in order:
  `Species caught` (`911 of 1,025`), `Shiny Pokémon`, `Trades`, `Hours played`, `Active hunts`.
- Section `Completion by game`: a bar chart titled `Completion by game`, one bar per owned
  game in the API's order. Label: the game's name, as a game link. Value: the completion
  percentage. Data table columns: `Game`, `Caught`, `Pokédex` (the regional Pokédex size),
  `Completion`.
- Section `Catches per month`: a column chart titled `Catches per month`, one column per
  month from `/api/stats/catches-by-month`. Label: the month (`2026-10`). Value: catches.
  Data table columns: `Month`, `Catches`.
- Section `Recent activity`: a list of the 10 newest items from `/api/activity`, newest
  first. Each list item starts with its date, then:
  - a trade: `Traded <gave> to <friend> for <received>`, with Pokémon links and a friend
    link; if it evolved, followed by `(evolved)`.
  - a hunt: `Shiny <species> found in <game> after <encounters> encounters`, with a
    Pokémon link and a game link.
  - a catch: `Caught <species> in <game>`, with a Pokémon link and a game link; if shiny,
    followed by `(shiny)`.

  Below the list, a control named `Show more` (a button or a link) adds the next 10 items
  to the list. Leave it out when there's nothing more.

### `/needs` – Needs

- `h1`: `Needs`.
- Filters (`/api/needs` parameters):
  - `<select>` labelled `Generation`: `All generations`, then the 9 generations in order.
  - `<select>` labelled `Source`: `All sources` (`all`), `Wild in my games` (`wild`),
    `Friends have it` (`friends`), `Trade evolution` (`trade-evolution`).
  - `<select>` labelled `Sort`: `Pokédex number` (`dex`), `Most friends` (`friends`).
- The text `<total> species needed` (`114 species needed`). With no results, the text
  `Nothing needed` in place of the table.
- Data table `Needed species`, 50 per page with pagination. Columns:
  `#` (dex number), `Pokémon`, `Types` (type names, in slot order, separated by `, `),
  `Wild in` (game names separated by `, `, or `—`), `Friends` (the count),
  `Trade evolution` (`<how> from <species>`, such as `Trade holding Metal Coat from Onix`,
  with a Pokémon link for the species; or `—`).

### `/catches` – Catches

- `h1`: `Catches`.
- Filters (`/api/catches` parameters):
  - `<select>` labelled `Game`: `All games`, then every game from `/api/meta`, in order.
  - `<select>` labelled `Method`: `All methods`, then the API's catch methods.
  - A checkbox labelled `Shiny only` (`shiny=true`).
  - `<select>` labelled `Sort`: `Newest first` (`-date`), `Oldest first` (`date`),
    `Highest level` (`-level`), `Lowest level` (`level`), `Pokédex number` (`dex`).
- The text `<total> catches`. With no results, `No catches` in place of the table.
- Data table `Catches`, 50 per page with pagination. Columns: `Date`, `Pokémon`, `Game`
  (game link), `Level`, `Method`, `Ball`, `Shiny`.

### `/games` – Games

- `h1`: `Games`.
- Data table `Games`, one row per owned game, in the API's order. Columns: `Game` (game
  link), `Platform`, `Copies`, `Playthroughs`, `Hours`, `Started`, `Last played`,
  `Pokédex` (`146 / 151`: caught in that game / regional Pokédex size), `Completion`.

### `/games/:id` – Game

- `h1`: the game's name. Every game in `/api/meta` has a page, owned or not.
- A description list, in order: `Generation`, `Platform`, `Counterpart` (a game link, or
  `—`). For an owned game, also: `Copies`, `Playthroughs`, `Hours`, `Started`,
  `Last played`, `Catches`, `Shiny`. For a game Robin doesn't own, the text
  `You don't own this game.` instead.
- Owned games only: section `Hours per month` with a column chart titled
  `Hours per month` for the last 12 months (label: the month; value: hours, one decimal).
  Data table columns: `Month`, `Hours`.
- Section `Pokédex`:
  - The text `<caught> of <size> caught` (`146 of 151 caught`; for a game Robin doesn't
    own, `0 of <size> caught`).
  - A `<select>` labelled `Show`: `All` (`all`), `Caught` (`caught`), `Missing`
    (`missing`), stored in the URL as `status`.
  - Data table `Regional Pokédex`, 50 per page with pagination. Columns: `No.` (the
    regional number), `Pokémon`, `Caught` (in this game). With no rows, the text
    `Nothing to show` instead.
- If the game has a counterpart: section `Version exclusives` with the text
  `Found in the wild in <counterpart> but not in <game>`, then a list with one item per
  species: a Pokémon link followed by `(caught)` or `(needed)`. If there are none, the
  text `None` instead of the list.

### `/friends` – Friends

- `h1`: `Friends`.
- The text `<total> friends`.
- Data table `Friends`, 25 per page with pagination. Columns: `Name` (friend link),
  `Friend code`, `Games`, `Trades`, `Can help`, `Last trade`.
- The `Name`, `Trades`, `Can help` and `Last trade` headers are sortable. Activating one
  (each header contains a link or button with the header's name) sorts by it: `Name`
  ascending (`sort=name`, the default), the others descending (`trades`, `can-help`,
  `last-trade`). The sort is in the URL as `sort` and goes back to page 1. The sorted
  header has `aria-sort` set to `ascending` or `descending`; the others have no
  `aria-sort` (or `aria-sort="none"`).

### `/friends/:id` – Friend

- `h1`: the friend's name.
- A description list, in order: `Friend code`, `Friends since`, `Trades`, `First trade`,
  `Last trade`.
- Section `Games`: a list of game links for the games they own, in the API's order.
- Section `Can help with`: the text `<n> species you need`, then a list of Pokémon links
  for them. With none, the text `Nothing you need` instead.
- Section `Trades per year`: a column chart titled `Trades per year` (label: the year;
  value: trades). Data table columns: `Year`, `Trades`.
- Section `Recent trades`: data table `Recent trades with <name>` with their 10 newest
  trades. Columns: `Date` (a link to the trade's page), `Game`, `Gave`, `Received`
  (Pokémon links). Then a link named `All trades with <name>` to `/trades?friend=<id>`.
  With no trades, the text `No trades yet` instead of the table.

### `/trades` – Trades

- `h1`: `Trades`.
- A link named `Log a trade` to `/trades/new`.
- Filters (`/api/trades` parameters):
  - `<select>` labelled `Friend`: `All friends`, then every friend by name.
  - `<select>` labelled `Game`: `All games`, then every game from `/api/meta`.
  - `<select>` labelled `Year`: `All years`, then each year from the year of the data's
    current date (`today` in `/api/meta`) back to 2016, newest first.
  - A checkbox labelled `Trade evolutions only` (`evolved=true`).
  - `<select>` labelled `Sort`: `Newest first` (`-date`), `Oldest first` (`date`).
- The text `<total> trades`. With no results, `No trades` in place of the table.
- Data table `Trades`, 50 per page with pagination. Columns: `Date` (a link to the trade's
  page), `Friend` (friend link), `Game` (game link), `Gave`, `Received` (Pokémon links),
  `Evolved`.

### `/trades/:id` – Trade

- `h1`: `Trade #<id>`.
- A description list, in order: `Date`, `Friend` (friend link), `Game` (game link),
  `You gave` (Pokémon link), `You received` (Pokémon link), `Evolved`: `No`, or
  `Yes, from <species> (<how>)` with a Pokémon link (`Yes, from Machoke (Trade)`).

### `/trades/new` – Log a trade

- `h1`: `Log a trade`.
- A form with these labelled fields:
  - `<select>` `Friend`: every friend, by name.
  - `<select>` `Game`: Robin's owned games, the first one selected.
  - `You gave` and `You received`: text inputs (or comboboxes) that take a species'
    English name, case-insensitively (`bulbasaur`, `Mr. Mime`). Suggestions as you type
    are welcome but not required.
  - `Date`: a date input defaulting to the data's current date.
- A submit button named `Log trade`. On success, go to the new trade's page. If the API
  rejects the trade, or a species name doesn't match any species, stay on the form and
  show the reason in an element with the `alert` role. Browser validation may stop an
  empty field, but a filled-in form must always reach that check.

### `/hunts` – Shiny hunts

- `h1`: `Shiny hunts`.
- Filters (`/api/hunts` parameters):
  - `<select>` labelled `Status`: `All statuses`, `Active` (`active`),
    `Completed` (`completed`), `Failed` (`failed`).
  - `<select>` labelled `Sort`: `Newest first` (`-started`), `Most encounters`
    (`encounters`).
- The text `<total> hunts`. With no results, `No hunts` in place of the table.
- Data table `Hunts`, 25 per page with pagination. Columns: `Pokémon` (sprite and a link
  named with the species' name to the hunt's page, `/hunts/<id>`), `Game`, `Method`,
  `Started`, `Ended`, `Status` (`Active`, `Completed` or `Failed`), `Encounters`.

### `/hunts/:id` – Shiny hunt

- `h1`: `<species> hunt` (`Ducklett hunt`).
- The species' sprite and a Pokémon link.
- A description list, in order: `Game` (game link), `Method`, `Started`, `Ended`,
  `Status`, `Encounters`.
- For an active hunt, a button named `Add encounter`. Each press adds one encounter
  through the API, and `Encounters` shows the new count.

### `/pokemon/:name` – Pokémon

- `h1`: the species' `displayName`.
- Near the top (not in a section): the dex number, the genus (`Mouse Pokémon`), the type
  names, and the official artwork (`<img>` whose alt text is the species' name).
- A description list, in order: `Caught` (number of catches), `Shiny`, `First caught`,
  `Last caught`.
- Section `Evolution`: every species in the family as Pokémon links, as a nested list:
  each species' evolutions are a list inside its list item (Eevee's has eight). Each
  species after the first is followed, in its list item, by how it evolves (`Level 16`,
  `Trade holding Metal Coat`).
- Section `Where to find`: data table `Availability`, one row per game whose regional
  Pokédex includes the species. Columns: `Game` (game link), `In the wild`, `Owned`.
- Section `Friends who have it`: the text `<total> friends`, then a list of friend links
  for the first 12 by name.
- Section `My catches`: data table `My catches of <species>` with the 20 newest catches.
  Columns: `Date`, `Game`, `Level`, `Method`, `Shiny`. With none, the text
  `Not caught yet` instead.

### Not found

Any URL that doesn't match a page above, or names a species, game, friend, trade or hunt
the API doesn't have, shows a page whose `h1` is `Not found`, plus a link to `/`.
Responding with HTTP status 404 is encouraged where your architecture allows it, but
isn't tested.

## Look and feel

The app must look like the reference screenshots in `design/screenshots/`. Each page is
captured at a mobile width (412 px, `*-mobile.png`) and a desktop width (1280 px,
`*-desktop.png`), with long pages cut off at 4000 px. Match layout, spacing, colors and
typography closely; pixel-for-pixel equality isn't required. On narrow screens, wide
tables may scroll sideways.

| Screenshot | URL |
| --- | --- |
| `overview` | `/` |
| `needs` | `/needs` |
| `catches` | `/catches?shiny=true` |
| `games` | `/games` |
| `game` | `/games/blue` |
| `friends` | `/friends?sort=trades` |
| `friend` | `/friends/1` |
| `trades` | `/trades` |
| `trade` | `/trades/1` |
| `trade-new` | `/trades/new` |
| `hunts` | `/hunts` |
| `hunt` | `/hunts/1` |
| `pokemon` | `/pokemon/slowpoke` |
| `not-found` | `/pokemon/missingno` |

- Use the custom properties in `design/tokens.css` for colors, spacing and type sizes.
  Copy the file into your app or import it, whichever suits your framework.
- Write your own CSS, in whatever way your framework favors (plain CSS, CSS modules,
  scoped styles, CSS-in-JS). Don't use a CSS framework or UI component library
  (such as Tailwind, Bootstrap or MUI).
- Use the system font stack in `tokens.css`. No web fonts and no icon fonts.
- No animations or transitions.
- Light theme only.

## Environment

- Node.js 24 and npm. You may install other package managers or tools.
- [`agent-browser`](https://github.com/vercel-labs/agent-browser) is installed for looking
  at pages in a headless browser (run `agent-browser --help`). Playwright's Chromium is
  installed for the tests.
- You have internet access (npm, documentation, web search).

## Constraints

- The app must work in the latest Chromium. Other browsers don't matter.
- Shadow DOM is allowed, but no closed shadow roots.
- Service workers, offline support and the like are optional.
- You may use npm packages, web search and documentation as you see fit, except charting
  libraries (see Charts).

## Tests

Run `npm test` from the repo root. It installs and builds `app/`, starts the API and your
app on separate ports (so they don't conflict with anything you're running), and runs the
Playwright tests in `tests/`. Extra arguments go to Playwright, for example
`npm test -- --grep "Needs"`.

The tests check what the page exposes to assistive technology (roles, accessible names,
text), the URLs and the charts' shapes; they don't otherwise check your HTML structure.
You're done when `npm test` passes in full.
