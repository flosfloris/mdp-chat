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
function buildSystemPrompt(events) {
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

REGOLE:
- Chiedi UNA cosa per volta, mai più domande insieme
- Non chiedere info che l'utente ha già dato
- Suggerisci max 3 eventi alla volta, i più rilevanti
- Per ogni evento includi: titolo, data, luogo, fascia d'età, prezzo (se presente)
- Se non trovi nulla di adatto, dillo chiaramente e suggerisci di iscriversi alla newsletter
- Non inventare eventi: usa SOLO quelli nella lista qui sotto
- Se l'utente chiede info non presenti (parcheggio, accessibilità...) dillo onestamente

EVENTI DISPONIBILI (${events.length} eventi futuri):
${JSON.stringify(events, null, 2)}`;
}

function filteredEvents() {
	const now = Date.now();
	const horizon = now + 60 * 24 * 60 * 60 * 1000;
	return cache.events
		.filter((e) => {
			const t = new Date(e.date).getTime();
			return !isNaN(t) && t >= now && t <= horizon;
		})
		.sort((a, b) => new Date(a.date) - new Date(b.date));
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

	const trimmed = messages.slice(-12).map((m) => ({
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

	try {
		const events = filteredEvents();
		const stream = await anthropic.messages.stream({
			model: MODEL,
			max_tokens: 1024,
			system: buildSystemPrompt(events),
			messages: trimmed,
		});

		for await (const chunk of stream) {
			if (
				chunk.type === "content_block_delta" &&
				chunk.delta?.type === "text_delta"
			) {
				send("delta", { text: chunk.delta.text });
			}
		}
		send("done", { ok: true, eventsUsed: events.length });
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
