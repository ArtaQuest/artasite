/**
 * A lazy-loading shim, so /meet can show the booking owner's panel without pulling the whole Book
 * page — with its calendar grid, slot maths and visitor flow — into the meetings chunk.
 */
export { AvailabilityPanel as default } from "./Book";
