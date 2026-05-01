// framer-api cattura globalThis.WebSocket al module-load time (rr=globalThis.WebSocket).
// Su Node 20 WebSocket non è globale: questo polyfill DEVE essere importato
// prima di framer-api, altrimenti rr resta undefined e new rr(...) fallisce.
import { WebSocket } from "ws";

if (!globalThis.WebSocket) {
	globalThis.WebSocket = WebSocket;
}
