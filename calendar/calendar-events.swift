// Prints a day's events from macOS Calendar, one JSON object per line, for `nod today`. It only
// reads. Run through CalendarEvents.app (build.sh) so the Calendar permission stays on the app.
// Usage: calendar-events <YYYY-MM-DD> [days]
import EventKit
import Foundation

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

let args = CommandLine.arguments
let day = DateFormatter()
day.dateFormat = "yyyy-MM-dd"
day.timeZone = .current
guard args.count == 2 || args.count == 3, let from = day.date(from: args[1]) else {
  fail("usage: calendar-events <YYYY-MM-DD> [days]", 64)
}
guard let days = args.count == 3 ? Int(args[2]) : 1, days > 0 else { fail("days must be a positive integer", 64) }

let store = EKEventStore()
if EKEventStore.authorizationStatus(for: .event) != .fullAccess {
  guard (try? await store.requestFullAccessToEvents()) == true else {
    fail("no Calendar access: allow nod calendar in System Settings → Privacy & Security → Calendars", 77)
  }
}
// Without access, or in a sandbox, EventKit can answer with no calendars rather than an error, and
// no events would read as a free day.
if store.calendars(for: .event).isEmpty {
  fail("no calendars are visible: allow Calendar access, or add a calendar to Calendar", 78)
}

guard let to = Calendar.current.date(byAdding: .day, value: days, to: from) else { fail("could not add days", 70) }
let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
  .sorted { $0.startDate < $1.startDate }
let time = ISO8601DateFormatter()
time.timeZone = .current

func status(_ value: EKParticipantStatus) -> String {
  switch value {
  case .accepted: "accepted"
  case .declined: "declined"
  case .tentative: "tentative"
  case .pending: "pending"
  default: "other"
  }
}

for event in events {
  var row: [String: Any] = [
    "start": time.string(from: event.startDate),
    "end": time.string(from: event.endDate),
    "allDay": event.isAllDay,
    "title": event.title ?? "",
    "calendar": event.calendar.title,
  ]
  if let value = event.location, !value.isEmpty { row["location"] = value }
  if let value = event.url { row["url"] = value.absoluteString }
  if let attendees = event.attendees, !attendees.isEmpty {
    row["attendees"] = attendees.count
    if let me = attendees.first(where: { $0.isCurrentUser }) { row["myStatus"] = status(me.participantStatus) }
  }
  let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
}
