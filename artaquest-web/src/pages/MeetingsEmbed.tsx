/** Lazy shim so ArtaChat can mount the meetings list without pulling the whole Meet module — with
 *  its lobby polling, call surface and room binding — into the chat chunk. */
export { MeetingsPanel as default } from "./Meet";
