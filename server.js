/**
 * Milano da Piccoli - Chatbot backend (v3: Framer Server API)
 *
 * Endpoints:
 *   POST /api/chat     - Streaming chat con Claude (SSE)
 *   GET  /api/health   - Health check + ultimo sync
 *   GET  /api/events   - Eventi attualmente in cache (debug)
 *
 * Variabili d'ambiente:
 *   ANTHROPIC_API_KEY        - chiave API Anthropic (obbligatoria)
 *   FRAMER_API_KEY           - chiave Framer Server API (obbligatoria)
 *   FRAMER_PROJECT_URL       - URL del progetto Framer
 *                              (es. https://framer.com/projects/Sites--xxxxx)
 *   FRAMER_EVENTS_COLLECTION_ID - opzionale, fallback "EcErkNOK6"
 *   ALLOWED_ORIGIN           - dominio del sito (es. https://milanodapiccoli.it)
 *   PORT                     - default 3000
 *   MODEL                    - default claude-haiku-4-5-20251001
 *   SYNC_INTERVAL_MS         - default 5min (300000)
 */

// IMPORTANTE: il polyfill WebSocket DEVE precedere l'import di framer-api,
// perché framer-api cattura globalThis.WebSocket al module-load time.
import "./ws-polyfill.js";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { connect } from "framer-api";
import "dotenv/config";

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MODEL = process.env.MODEL || "claude-haiku-4-5-20251001";
const FRAMER_PROJECT_URL = process.env.FRAMER_PROJECT_URL;
const FRAMER_API_KEY = process.env.FRAMER_API_KEY;
const EVENTS_COLLECTION_ID =
	process.env.FRAMER_EVENTS_COLLECTION_ID || "EcErkNOK6";
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 5 * 60 * 1000);
// Base URL della pagina evento sul sito; lo slug viene appeso in coda.
const EVENT_PAGE_BASE =
	process.env.EVENT_PAGE_BASE || "https://www.milanodapiccoli.it/eventi/";

const anthropic = new Anthropic();

// Startup diagnostics (senza esporre i secret)
console.log("[boot] env check:", {
	ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
	FRAMER_API_KEY: !!process.env.FRAMER_API_KEY,
	FRAMER_API_KEY_prefix: (process.env.FRAMER_API_KEY || "").slice(0, 4),
	FRAMER_PROJECT_URL: process.env.FRAMER_PROJECT_URL || "(missing)",
	EVENTS_COLLECTION_ID,
	MODEL,
});

// ---------- Cache ----------
let cache = { events: [], syncedAt: null, error: null };

// Estrae un valore "leggibile" da un campo Framer.
// fieldData arriva come { type, value, ... }: bisogna scartare il wrapper.
function readField(field, wrapped) {
	if (wrapped == null) return "";
	const raw =
		typeof wrapped === "object" && wrapped !== null && "value" in wrapped
			? wrapped.value
			: wrapped;
	if (raw == null) return "";
	if (field?.type === "enum" && Array.isArray(field.cases)) {
		const match = field.cases.find((c) => c.id === raw);
		return match ? match.name : String(raw);
	}
	if (raw instanceof Date) return raw.toISOString();
	if (typeof raw === "object" && raw.url) return raw.url; // image objects
	if (typeof raw === "object") return ""; // unknown wrapper, evita "[object Object]"
	return String(raw);
}

async function syncFromFramer() {
	if (!FRAMER_PROJECT_URL || !FRAMER_API_KEY) {
		cache.error = "FRAMER_PROJECT_URL o FRAMER_API_KEY mancanti";
		console.warn("[sync]", cache.error);
		return;
	}

	let framer;
	try {
		framer = await connect(FRAMER_PROJECT_URL, FRAMER_API_KEY);

		// Trova la collection Events: prima per ID, poi per nome
		const collections = await framer.getCollections();
		let collection = collections.find((c) => c.id === EVENTS_COLLECTION_ID);
		if (!collection)
			collection = collections.find((c) => /events?/i.test(c.name || ""));
		if (!collection) {
			throw new Error(
				`Collection eventi non trovata. ID cercato: ${EVENTS_COLLECTION_ID}. ` +
					`Disponibili: ${collections.map((c) => `${c.name} (${c.id})`).join(", ")}`,
			);
		}

		const fields = await collection.getFields();
		const fieldByName = new Map();
		for (const f of fields)
			fieldByName.set((f.name || "").toLowerCase(), f);

		const items = await collection.getItems();

		const get = (item, ...names) => {
			for (const n of names) {
				const f = fieldByName.get(n.toLowerCase());
				if (f) {
					const v = readField(f, item.fieldData?.[f.id]);
					if (v) return v;
				}
			}
			return "";
		};

		// Estrae il valore raw (non stringificato) per campi numerici
		const getRaw = (item, ...names) => {
			for (const n of names) {
				const f = fieldByName.get(n.toLowerCase());
				if (f) {
					const wrapped = item.fieldData?.[f.id];
					if (wrapped && typeof wrapped === "object" && "value" in wrapped) {
						return wrapped.value;
					}
				}
			}
			return null;
		};

		const mapped = items
			.filter((it) => !it.draft)
			.map((it) => ({
				id: it.id,
				slug: it.slug,
				title: get(it, "title", "name", "nome", "titolo"),
				// "Date from" è ISO; "Date" è DD/MM/YYYY non parsabile da new Date()
				date: get(
					it,
					"date from",
					"start date",
					"data inizio",
					"date",
					"data",
				),
				endDate: get(it, "date to", "end date", "data fine"),
				location: get(it, "location", "place", "venue", "luogo"),
				address: get(it, "address", "indirizzo"),
				municipio: get(it, "municipio", "zona", "district"),
				ageRange: get(it, "age range", "age", "ages", "età"),
				ageFrom: getRaw(it, "age_from", "age from"),
				ageTo: getRaw(it, "age_to", "age to"),
				price: get(it, "price", "prezzo", "costo"),
				description: get(it, "description", "descrizione").slice(
					0,
					500,
				),
				url: get(it, "url", "link"),
				type: get(it, "type", "tipo", "categoria"),
			}));

		cache = {
			events: mapped,
			syncedAt: new Date().toISOString(),
			error: null,
		};
		console.log(`[sync] ${mapped.length} eventi da "${collection.name}"`);
	} catch (err) {
		cache.error = err.message || "unknown";
		console.error("[sync] errore completo:");
		console.error("  name:", err.name);
		console.error("  message:", err.message);
		console.error("  code:", err.code);
		console.error("  cause:", err.cause);
		console.error("  stack:", err.stack);
		if (err.response) console.error("  response:", err.response);
		if (err.data) console.error("  data:", err.data);
	} finally {
		if (framer) {
			try {
				await framer.disconnect();
			} catch {}
		}
	}
}

// Sync iniziale + intervallo
syncFromFramer();
setInterval(syncFromFramer, SYNC_INTERVAL_MS);

// ---------- System prompt ----------
function buildSystemPrompt() {
	const today = new Date().toLocaleDateString("it-IT", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});

	return `Sei l'assistente di Milano da Piccoli, una guida per famiglie a Milano.
Il tuo ruolo è aiutare i genitori a trovare l'evento giusto per i loro bambini.

OGGI È: ${today}

TONO:
- Caldo, pratico, mai prolisso
- Italiano colloquiale ma curato
- Mai usare emoji a meno che non lo faccia l'utente per primo

DOMANDE DA FARE (una per volta, solo se l'info manca, nell'ordine):
1. Età del bambino
2. Se vuole rimanere a Milano e, in caso, se ha una preferenza di municipio
3. Eventualmente la tipologia del laboratorio/attività (es. creativo, sportivo, musicale, ristorante…)

COME CERCARE EVENTI:
- Usa il tool "search_events" SOLO quando hai abbastanza info per restringere (almeno data o età)
- Se mancano info chiave, prima chiedile (una per volta), poi cerca
- Le date vanno passate al tool in formato ISO YYYY-MM-DD
- Per "questo weekend", "domani", ecc. converti tu in date ISO basandoti su OGGI

REGOLE:
- Chiedi UNA cosa per volta, mai più domande insieme
- Non chiedere info che l'utente ha già dato
- Suggerisci max 3 eventi alla volta, i più rilevanti
- Per ogni evento includi: titolo, data, luogo, fascia d'età, prezzo (se presente)
- IMPORTANTE: ogni titolo evento deve essere un link Markdown cliccabile usando il campo "pageUrl" del tool result (pagina su milanodapiccoli.it), formato esatto: [Titolo evento](pageUrl). Se "pageUrl" è vuoto, scrivi solo il titolo senza link.
- Se l'utente chiede dove prenotare/comprare biglietti e il campo "bookingUrl" è presente, puoi aggiungere [Prenota](bookingUrl) accanto.
- Se il tool non restituisce nulla, dillo chiaramente e suggerisci di iscriversi alla newsletter
- Non inventare eventi: usa SOLO quelli restituiti dal tool
- Se l'utente chiede info non presenti (parcheggio, accessibilità...) dillo onestamente`;
}

// ---------- Event search (tool implementation) ----------
function parseDate(s) {
	if (!s) return NaN;
	const t = new Date(s).getTime();
	return isNaN(t) ? NaN : t;
}

function searchEvents({
	date,
	dateFrom,
	dateTo,
	age,
	municipio,
	type,
	limit = 10,
} = {}) {
	const now = Date.now();
	let candidates = cache.events.filter((e) => {
		// Esclude eventi già finiti
		const eFrom = parseDate(e.date);
		const eTo = parseDate(e.endDate) || eFrom;
		return !isNaN(eFrom) && (isNaN(eTo) ? eFrom >= now : eTo >= now);
	});

	if (date) {
		const target = parseDate(date);
		if (!isNaN(target)) {
			const dayEnd = target + 24 * 60 * 60 * 1000 - 1;
			candidates = candidates.filter((e) => {
				const eFrom = parseDate(e.date);
				const eTo = parseDate(e.endDate);
				const to = isNaN(eTo) ? eFrom : eTo;
				return eFrom <= dayEnd && to >= target;
			});
		}
	}

	if (dateFrom || dateTo) {
		const qFrom = dateFrom ? parseDate(dateFrom) : -Infinity;
		const qTo = dateTo ? parseDate(dateTo) + 24 * 60 * 60 * 1000 - 1 : Infinity;
		candidates = candidates.filter((e) => {
			const eFrom = parseDate(e.date);
			const eTo = parseDate(e.endDate);
			const to = isNaN(eTo) ? eFrom : eTo;
			return eFrom <= qTo && to >= qFrom;
		});
	}

	if (typeof age === "number") {
		candidates = candidates.filter((e) => {
			// Se la fascia è esplicitamente "non specificata" o "tutte le età",
			// l'evento è aperto a qualsiasi età
			const label = (e.ageRange || "").toLowerCase();
			if (
				label.includes("non specificat") ||
				label.includes("tutte le et")
			) {
				return true;
			}
			const from = typeof e.ageFrom === "number" ? e.ageFrom : null;
			const to = typeof e.ageTo === "number" ? e.ageTo : null;
			// Se mancano entrambi i numeri o sono entrambi 0 (campo non
			// compilato), considera l'evento aperto a tutte le età
			if (from === null && to === null) return true;
			if ((from ?? 0) === 0 && (to ?? 0) === 0) return true;
			return age >= (from ?? 0) && age <= (to ?? 99);
		});
	}

	if (municipio) {
		const m = String(municipio).toLowerCase();
		candidates = candidates.filter((e) =>
			(e.municipio || "").toLowerCase().includes(m),
		);
	}

	if (type) {
		const t = String(type).toLowerCase();
		candidates = candidates.filter((e) =>
			(e.type || "").toLowerCase().includes(t),
		);
	}

	candidates.sort((a, b) => parseDate(a.date) - parseDate(b.date));

	const cap = Math.min(Math.max(1, limit || 10), 30);
	return candidates.slice(0, cap).map((e) => ({
		title: e.title,
		date: e.date,
		endDate: e.endDate || undefined,
		location: e.location,
		address: e.address || undefined,
		municipio: e.municipio || undefined,
		ageRange: e.ageRange,
		ageFrom: e.ageFrom ?? undefined,
		ageTo: e.ageTo ?? undefined,
		price: e.price || undefined,
		description: e.description,
		pageUrl: e.slug ? EVENT_PAGE_BASE + e.slug : undefined,
		bookingUrl: e.url || undefined,
		type: e.type || undefined,
	}));
}

const TOOLS = [
	{
		name: "search_events",
		description:
			"Cerca eventi futuri per famiglie a Milano dal CMS Milano da Piccoli. Filtra per data, età, municipio, tipologia. Restituisce un array di eventi (max 30). Un evento copre la data X se Date from <= X <= Date to.",
		input_schema: {
			type: "object",
			properties: {
				date: {
					type: "string",
					description:
						"Data ISO YYYY-MM-DD. Restituisce eventi che cadono in questo giorno (anche se multi-giorno).",
				},
				dateFrom: {
					type: "string",
					description: "Inizio range ISO YYYY-MM-DD (usa con dateTo).",
				},
				dateTo: {
					type: "string",
					description: "Fine range ISO YYYY-MM-DD (usa con dateFrom).",
				},
				age: {
					type: "number",
					description:
						"Età del bambino in anni. Filtra eventi con age_from <= age <= age_to.",
				},
				municipio: {
					type: "string",
					description: "Municipio di Milano (es. '1', '3'). Match case-insensitive.",
				},
				type: {
					type: "string",
					description:
						"Tipologia (es. 'laboratorio', 'ristorante', 'mostra'). Match case-insensitive.",
				},
				limit: {
					type: "number",
					description: "Max eventi da restituire. Default 10, max 30.",
				},
			},
		},
	},
];

// Mantenuto per /api/health e /api/events: conta eventi futuri ad orizzonte 60gg
function filteredEvents() {
	const now = Date.now();
	const horizon = now + 60 * 24 * 60 * 60 * 1000;
	return cache.events
		.filter((e) => {
			const t = parseDate(e.date);
			return !isNaN(t) && t >= now && t <= horizon;
		})
		.sort((a, b) => parseDate(a.date) - parseDate(b.date));
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(cors({ origin: ALLOWED_ORIGIN, methods: ["POST", "GET"] }));

app.get("/api/health", (req, res) => {
	res.json({
		ok: true,
		model: MODEL,
		eventsTotal: cache.events.length,
		eventsFuture: filteredEvents().length,
		syncedAt: cache.syncedAt,
		syncError: cache.error,
	});
});

app.get("/api/events", (req, res) => {
	res.json({ ...cache, filteredCount: filteredEvents().length });
});

app.get("/api/debug", async (req, res) => {
	const result = {
		env: {
			ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
			FRAMER_API_KEY: !!process.env.FRAMER_API_KEY,
			FRAMER_API_KEY_prefix: (process.env.FRAMER_API_KEY || "").slice(
				0,
				4,
			),
			FRAMER_PROJECT_URL: process.env.FRAMER_PROJECT_URL || null,
			EVENTS_COLLECTION_ID,
		},
		steps: [],
	};
	let framer;
	try {
		result.steps.push("connecting...");
		framer = await connect(
			process.env.FRAMER_PROJECT_URL,
			process.env.FRAMER_API_KEY,
		);
		result.steps.push("connected");

		const projectInfo = await framer.getProjectInfo();
		result.steps.push(`projectInfo: ${projectInfo?.name || "(no name)"}`);

		const collections = await framer.getCollections();
		result.collections = collections.map((c) => ({
			id: c.id,
			name: c.name,
		}));
		result.steps.push(`got ${collections.length} collections`);

		const target =
			collections.find((c) => c.id === EVENTS_COLLECTION_ID) ||
			collections.find((c) => /events?/i.test(c.name || ""));

		if (target) {
			result.targetCollection = { id: target.id, name: target.name };
			const fields = await target.getFields();
			result.fields = fields.map((f) => ({
				id: f.id,
				name: f.name,
				type: f.type,
			}));
			const items = await target.getItems();
			result.itemsCount = items.length;
			result.firstItem = items[0]
				? {
						id: items[0].id,
						slug: items[0].slug,
						draft: items[0].draft,
						fieldData: items[0].fieldData,
					}
				: null;
		} else {
			result.targetCollection = null;
		}
		res.json({ ok: true, ...result });
	} catch (err) {
		res.status(500).json({
			ok: false,
			...result,
			error: {
				name: err.name,
				message: err.message,
				code: err.code,
				cause: err.cause ? String(err.cause) : null,
				stack: err.stack,
			},
		});
	} finally {
		if (framer) {
			try {
				await framer.disconnect();
			} catch {}
		}
	}
});

app.post("/api/chat", async (req, res) => {
	const { messages } = req.body || {};

	if (!Array.isArray(messages) || messages.length === 0) {
		return res.status(400).json({ error: "messages array richiesto" });
	}

	const conversation = messages.slice(-12).map((m) => ({
		role: m.role === "assistant" ? "assistant" : "user",
		content: String(m.content || "").slice(0, 4000),
	}));

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");

	const send = (event, data) => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	const system = buildSystemPrompt();
	const MAX_TOOL_TURNS = 4;
	let toolCallsMade = 0;

	try {
		for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
			const stream = anthropic.messages.stream({
				model: MODEL,
				max_tokens: 1024,
				system,
				tools: TOOLS,
				messages: conversation,
			});

			for await (const chunk of stream) {
				if (
					chunk.type === "content_block_delta" &&
					chunk.delta?.type === "text_delta"
				) {
					send("delta", { text: chunk.delta.text });
				}
			}

			const finalMessage = await stream.finalMessage();

			if (finalMessage.stop_reason !== "tool_use") {
				break;
			}

			// Esegui i tool richiesti, accoda assistant + tool_result e ricicla
			conversation.push({
				role: "assistant",
				content: finalMessage.content,
			});

			const toolResults = [];
			for (const block of finalMessage.content) {
				if (block.type !== "tool_use") continue;
				toolCallsMade++;
				let result;
				try {
					if (block.name === "search_events") {
						result = searchEvents(block.input || {});
					} else {
						result = { error: `Tool sconosciuto: ${block.name}` };
					}
				} catch (e) {
					result = { error: e.message || "Tool error" };
				}
				toolResults.push({
					type: "tool_result",
					tool_use_id: block.id,
					content: JSON.stringify(result),
				});
			}
			conversation.push({ role: "user", content: toolResults });
		}

		send("done", { ok: true, toolCallsMade });
	} catch (err) {
		console.error("[chat] errore:", err);
		send("error", { message: err.message || "Errore interno" });
	} finally {
		res.end();
	}
});

app.listen(PORT, () => {
	console.log(`[server] in ascolto su :${PORT}`);
});
