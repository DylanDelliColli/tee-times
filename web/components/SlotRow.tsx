import type { Slot } from "../../src/core/slot.js";

export interface SlotRowProps {
  slot: Slot;
  /** Human-readable course name, resolved by the caller from CourseStatus/registry. */
  courseDisplayName: string;
}

/**
 * One bookable tee-time row: course, time, holes, spots, optional price, and
 * a prominent "Book ->" deep link straight to the course's own booking page
 * (invariant I3 — slot.bookingUrl, never a generic search-app URL). Opens in
 * a new tab so leaving the shared search view never loses the search state.
 */
export function SlotRow({ slot, courseDisplayName }: SlotRowProps) {
  return (
    <li className="slot-row" data-testid="slot-row" data-course-id={slot.courseId}>
      <span className="slot-course">{courseDisplayName}</span>
      <span className="slot-date">{slot.date}</span>
      <span className="slot-time">{slot.time}</span>
      <span className="slot-holes">{slot.holes} holes</span>
      <span className="slot-spots">{slot.spotsAvailable} spot{slot.spotsAvailable === 1 ? "" : "s"}</span>
      <span className="slot-price">{slot.price !== undefined ? `$${slot.price.toFixed(2)}` : ""}</span>
      <a
        className="slot-book-link"
        href={slot.bookingUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Book &rarr;
      </a>
    </li>
  );
}
