// Thin client for the meal-tracker website's /api endpoints.

const BASE = (process.env.MEAL_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.MEAL_API_TOKEN ?? "";

if (!BASE) throw new Error("MEAL_API_URL is required (e.g. https://your-site.netlify.app)");

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(method !== "GET" && { authorization: `Bearer ${TOKEN}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Meal API ${method} ${path} failed (${res.status}): ${text}`);
  return JSON.parse(text) as T;
}
