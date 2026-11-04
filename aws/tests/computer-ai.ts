// AI_PROVIDER=computer checks: Huddle's AI requests go to the owner's AI on their Computer (ask_ai,
// transcribe), Gemini answers what the Computer can't, and a Computer that says no hands over to Gemini.
// No network: fetch is replaced by a fake Computer app door and a fake Gemini.
// Usage: deno run -A aws/tests/computer-ai.ts
Deno.env.set("AI_PROVIDER", "computer");
Deno.env.set("COMPUTER_URL", "http://door.test:3090");
Deno.env.set("COMPUTER_EVENTS_KEY", "huddle-key-for-tests-0123456789");
Deno.env.set("GEMINI_API_KEY", "gemini-test-key");

// deno-lint-ignore no-explicit-any
type Any = any;
const calls: { to: string; name?: string; args?: Any; headers?: Headers }[] = [];
let computerSays: (name: string, args: Any) => { text: string; isError?: boolean } = () => ({ text: "{}" });
let geminiFails = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url === "http://door.test:3090/api/app-mcp") {
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    calls.push({ to: "computer", name: body.params.name, args: body.params.arguments, headers });
    const out = computerSays(body.params.name, body.params.arguments);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: out.text }], ...(out.isError ? { isError: true } : {}) } });
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    calls.push({ to: "gemini" });
    if (geminiFails) return new Response("quota", { status: 429 });
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"from":"gemini"}' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://a.test", title: "A" } }] } }] });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { gemini, geminiJson } = await import("../../supabase/functions/_shared/util.ts");

let fails = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); if (!ok) fails++; };
const reset = () => { calls.length = 0; geminiFails = false; };
const SCHEMA = { type: "OBJECT", properties: { title: { type: "STRING" } }, required: ["title"] };

// 1. Structured answers come from the Computer, with the schema spelled out, through Huddle's own key.
reset();
computerSays = () => ({ text: 'Here you go:\n```json\n{"title":"Awards night"}\n```' });
const brief = await geminiJson<{ title: string }>([{ text: "Name this event" }], SCHEMA, "m", "Be brief.");
check("JSON answer comes from the Computer", brief.title === "Awards night" && calls.length === 1 && calls[0].to === "computer");
check("asked with Huddle's own app key", calls[0].headers?.get("x-computer-app") === "huddle" && calls[0].headers?.get("authorization") === "Bearer huddle-key-for-tests-0123456789");
check("schema and system text are in the instructions", /JSON Schema/.test(calls[0].args.instructions) && /Be brief\./.test(calls[0].args.instructions));

// 2. A reply that isn't JSON is asked for once more.
reset();
let n = 0;
computerSays = () => ({ text: n++ ? '{"title":"Second try"}' : "Sorry, here is a title: Party" });
check("bad JSON is asked again", (await geminiJson<{ title: string }>([{ text: "x" }], SCHEMA)).title === "Second try" && calls.length === 2);

// 3. Pictures go to the Computer's AI.
reset();
computerSays = () => ({ text: '{"title":"Whiteboard"}' });
await geminiJson([{ inline_data: { mime_type: "image/png", data: "aGVsbG8=" } }, { text: "Read this" }], SCHEMA);
check("pictures are sent to ask_ai", calls[0].name === "ask_ai" && calls[0].args.images?.[0]?.mime === "image/png" && calls[0].args.images[0].data === "aGVsbG8=");

// 4. A voice note is heard by the Computer's speech service, then read by its AI.
reset();
computerSays = (name) => name === "transcribe" ? { text: JSON.stringify({ text: "Let's do red and green" }) } : { text: '{"title":"Colours","transcript":"Let\'s do red and green"}' };
const voice = await geminiJson<Any>([{ inline_data: { mime_type: "audio/wav", data: "UklGRg==" } }, { text: "Transcribe it" }], SCHEMA);
check("voice notes: transcribe, then ask_ai", calls.map((c) => c.name).join() === "transcribe,ask_ai" && voice.transcript === "Let's do red and green");
check("the words reach the AI as the transcript", /Let's do red and green/.test(calls[1].args.prompt));

// 5. Live speech (audio only) is just the words, with no AI call.
reset();
const { text: heard } = await gemini({ contents: [{ role: "user", parts: [{ inline_data: { mime_type: "audio/wav", data: "UklGRg==" } }] }] });
check("audio alone is only transcribed", heard === "Let's do red and green" && calls.length === 1 && calls[0].name === "transcribe");

// 6. Web search goes to Gemini first (with its sources), and to the Computer when Gemini can't.
reset();
const search = await gemini({ contents: [{ role: "user", parts: [{ text: "research" }] }], tools: [{ google_search: {} }] });
check("search goes to Gemini first", calls.map((c) => c.to).join() === "gemini" && search.raw.candidates[0].groundingMetadata.groundingChunks.length === 1);
reset();
geminiFails = true;
computerSays = () => ({ text: "A research brief from memory." });
const unsourced = await gemini({ contents: [{ role: "user", parts: [{ text: "research" }] }], tools: [{ google_search: {} }] });
check("search falls back to the Computer, unsourced", unsourced.text === "A research brief from memory." && /can't search the web/.test(calls[1].args.instructions));

// 7. Video and PDFs only ever go to Gemini.
reset();
await gemini({ contents: [{ role: "user", parts: [{ inline_data: { mime_type: "application/pdf", data: "JVBERg==" } }] }] });
check("PDFs go to Gemini", calls.map((c) => c.to).join() === "gemini");

// 8. When the Computer says no for the day, Gemini answers, and the Computer isn't asked again for a while.
reset();
computerSays = () => ({ text: "This app has used today's AI allowance on your Computer. It resets tomorrow.", isError: true });
const fallback = await geminiJson<Any>([{ text: "x" }], SCHEMA);
check("Computer's no hands over to Gemini", fallback.from === "gemini" && calls.map((c) => c.to).join() === "computer,gemini");
reset();
await geminiJson<Any>([{ text: "y" }], SCHEMA);
check("then Gemini directly while the Computer rests", calls.map((c) => c.to).join() === "gemini");

console.log(fails ? `\n${fails} failed` : "\nAll passed");
Deno.exit(fails ? 1 : 0);
