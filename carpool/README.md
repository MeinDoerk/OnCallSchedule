# Family Carpool

Family Carpool turns a tangle of team calendars into one week-by-week plan
that shows who drives each child to every practice and game and who brings
them home. It also raises two kinds of flags before they become a problem in
the car line: a driver who has been booked for two places at once, and two
families about to make the same drive when one car would do.

## What it does

- **Team calendars.** Subscribe to a team's calendar link (webcal:// or
  https://…ics from TeamSnap, GameChanger, SportsEngine, league sites and
  most others), import a downloaded `.ics` file, or type events in by hand.
  Each event carries a title, start and end date and time, and location.
  Subscribed calendars refresh on their own when the app is opened.
- **Practice or game.** Every event is labelled `PRACTICE` or `GAME`. Imported
  events are guessed from their titles ("vs.", "@", "tournament", "meet" and so
  on count as games), and a single click on the label changes it. That choice
  survives later calendar refreshes.
- **Families, drivers and children.** Add a family, its drivers and its
  children. Put children on teams with a checkbox. Removing someone from a
  family keeps them under "Not in a family" until they are reassigned or
  deleted for good.
- **The week view.** Each day lists every child's activity with the
  practice/game label, start and end times, location, team, and the driver
  for the trip there and the trip home.

## How rides are worked out

- A child rides with their family's driver. The starred driver is the
  family's usual one; any single trip can be handed to someone else,
  including another family's driver, from the week view.
- Every trip is planned as **20 minutes**: the drive there ends when the event
  starts, and the drive home begins when it ends.
- **Driver conflicts** (red) appear when one driver's trips overlap and head to
  different places.
- **Carpool opportunities** (green) appear when different drivers are headed
  the same way, to the same location, within 30 minutes of one another. The
  banner offers to hand the whole run to a driver who is free to take it.
  Several children in one car going to one place never count as a conflict.

## Running it

It needs [Node.js](https://nodejs.org) 20 or newer and has no other
dependencies.

```sh
cd carpool
npm start          # then open http://localhost:3000
npm test           # calendar parsing, trip rules and server checks
```

Everything is kept in `carpool/data/state.json`, so every family who opens
the same address sees the same schedule. If two people save at the same
moment, the second is shown the newer version instead of overwriting it.
Set `PORT` or `DATA_FILE` to change the port or where the data lives.

Opened directly as a file without the server, the app still works, but it
saves only in that browser and may be unable to load calendar links.

## Before sharing it beyond a trusted group

This first version has no sign-in: anyone who can reach the address can view
and change the schedule. Before putting it on the public internet, add
accounts (or at least a shared family passcode) and host it behind HTTPS.
