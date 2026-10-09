import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "./api.ts";

const TIMEZONE = process.env.TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const INSTRUCTIONS = `
This server logs meals to the user's personal meal tracker. You are the nutrition estimator:
there is no food database. When the user shares a photo or description of food:

1. Identify each distinct food and drink, estimate its portion (grams, cups, pieces, etc.),
   and estimate calories, protein, carbs, fat (and fiber when meaningful) from your own knowledge.
2. If anything that materially changes the estimate is unclear, ASK before logging. Typical
   questions: what a dish or item actually is, portion size or how much was eaten, cooking
   method or added oil/butter, sauces and dressings, what's in a drink, whether something
   was shared or left over. Ask only what matters, and batch your questions in one message.
3. Once you have enough to go on, call log_meal. Record anything you assumed in
   "assumptions" and set "confidence" honestly.
4. After logging, briefly tell the user the estimated totals and how many calories they have
   left today and this week (log_meal returns this when goals are set).

Photos are only for your analysis; never try to store or upload them.
`.trim();

const num = z.number().nonnegative();

const item = z.object({
  name: z.string().describe("Food or drink, e.g. 'Grilled chicken thigh'"),
  portion: z.string().optional().describe("Estimated amount, e.g. '150 g', '1 cup', '2 slices'"),
  calories: num,
  protein_g: num,
  carbs_g: num,
  fat_g: num,
  fiber_g: num.optional(),
});

const mealFields = {
  title: z.string().describe("Short name for the meal, e.g. 'Chicken burrito bowl'"),
  meal_type: z.enum(["breakfast", "lunch", "dinner", "snack", "drink"]),
  items: z.array(item).min(1).describe("One entry per distinct food or drink"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(`Local date eaten, YYYY-MM-DD. Defaults to today (${TIMEZONE}).`),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe(`Local time eaten, 24h HH:MM. Defaults to now (${TIMEZONE}).`),
  confidence: z.enum(["low", "medium", "high"]).describe("How confident the estimate is"),
  assumptions: z
    .array(z.string())
    .optional()
    .describe("Assumptions behind the estimate, e.g. 'Assumed ~1 tbsp olive oil for cooking'"),
  notes: z.string().optional(),
};

type Totals = { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
type Meal = { id: string; date: string; time?: string; title: string; meal_type: string; totals: Totals };

function nowLocal() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

type Targets = { daily_calories: number; weekly_calories: number; protein_g: number; carbs_g: number; fat_g: number };
type ProfileResponse = { profile: { week_start?: "monday" | "sunday" } | null; targets: Targets | null };

const shiftDay = (date: string, by: number) =>
  new Date(Date.parse(date + "T12:00:00Z") + by * 86400000).toISOString().slice(0, 10);

/** Calories/macros left for the day and week containing `date`, or a note that no goals are set. */
async function progress(date: string): Promise<string> {
  const { profile, targets } = await api<ProfileResponse>("GET", "/profile");
  if (!targets) return "No calorie goals set yet; the user can set them on the website's Goals tab.";

  const startDow = profile?.week_start === "sunday" ? 0 : 1;
  const weekStart = shiftDay(date, -((new Date(date + "T12:00:00Z").getUTCDay() - startDow + 7) % 7));
  const weekEnd = shiftDay(weekStart, 6);
  const { meals } = await api<{ meals: Meal[] }>("GET", `/meals?from=${weekStart}&to=${weekEnd}`);

  const sum = (list: Meal[], k: keyof Totals) => Math.round(list.reduce((a, m) => a + m.totals[k], 0));
  const day = meals.filter((m) => m.date === date);
  const left = (goal: number, eaten: number) =>
    goal - eaten >= 0 ? `${goal - eaten} left` : `${eaten - goal} over`;

  return [
    `Day ${date}: ${sum(day, "calories")} of ${targets.daily_calories} kcal eaten (${left(targets.daily_calories, sum(day, "calories"))}). ` +
      `Protein ${sum(day, "protein_g")}/${targets.protein_g}g, carbs ${sum(day, "carbs_g")}/${targets.carbs_g}g, fat ${sum(day, "fat_g")}/${targets.fat_g}g.`,
    `Week ${weekStart} to ${weekEnd}: ${sum(meals, "calories")} of ${targets.weekly_calories} kcal eaten ` +
      `(${left(targets.weekly_calories, sum(meals, "calories"))}).`,
  ].join("\n");
}

const summarize = (m: Meal) =>
  `${m.title} (${m.meal_type}, ${m.date}${m.time ? " " + m.time : ""}) — ${m.totals.calories} kcal, ` +
  `P ${m.totals.protein_g}g · C ${m.totals.carbs_g}g · F ${m.totals.fat_g}g [id ${m.id}]`;

export function createServer(): McpServer {
  const server = new McpServer({ name: "meal-tracker", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "log_meal",
    {
      title: "Log meal",
      description:
        "Save a meal with your estimated calories and macros per item. Only call this once you can " +
        "identify the foods and portions reasonably well; if you can't, ask the user clarifying " +
        "questions first. Totals are computed from the items.",
      inputSchema: mealFields,
    },
    async (input) => {
      const now = nowLocal();
      const isToday = !input.date || input.date === now.date;
      const meal = await api<Meal>("POST", "/meals", {
        ...input,
        date: input.date ?? now.date,
        time: input.time ?? (isToday ? now.time : undefined),
        assumptions: input.assumptions ?? [],
      });
      return text(`Logged: ${summarize(meal)}\n\n${await progress(meal.date)}`);
    },
  );

  server.registerTool(
    "list_meals",
    {
      title: "List meals",
      description:
        "List logged meals with per-day totals. Use for questions like 'what did I eat today' " +
        "or 'how many calories this week', and to find a meal id before updating or deleting.",
      inputSchema: {
        from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive). Defaults to 6 days ago."),
        to: z.string().optional().describe("End date YYYY-MM-DD (inclusive). Defaults to today."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => {
      const today = nowLocal().date;
      const start = from ?? new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0, 10);
      const end = to ?? today;
      const { meals } = await api<{ meals: Meal[] }>(
        "GET",
        `/meals?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`,
      );
      if (!meals.length) return text(`No meals logged between ${start} and ${end}.`);

      const days = new Map<string, Meal[]>();
      for (const m of meals) days.set(m.date, [...(days.get(m.date) ?? []), m]);
      const out = [...days].map(([date, ms]) => {
        const sum = (k: keyof Totals) => Math.round(ms.reduce((a, m) => a + m.totals[k], 0));
        return [
          `${date}: ${sum("calories")} kcal · P ${sum("protein_g")}g · C ${sum("carbs_g")}g · F ${sum("fat_g")}g`,
          ...ms.map((m) => `  - ${summarize(m)}`),
        ].join("\n");
      });
      return text(out.join("\n\n"));
    },
  );

  server.registerTool(
    "get_progress",
    {
      title: "Calories left",
      description:
        "How many calories and macros the user has eaten and has left against their goals, for a day " +
        "and the week containing it. Use for 'how much do I have left', 'am I on track this week', etc.",
      inputSchema: {
        date: z.string().optional().describe(`YYYY-MM-DD. Defaults to today (${TIMEZONE}).`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => text(await progress(date ?? nowLocal().date)),
  );

  server.registerTool(
    "get_meal",
    {
      title: "Get meal",
      description: "Get full details of one meal, including item breakdown and assumptions.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => text(await api("GET", `/meals/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "update_meal",
    {
      title: "Update meal",
      description:
        "Correct a logged meal (e.g. the user says the portion was bigger, or adds a forgotten item). " +
        "Pass only the fields to change; 'items' replaces the whole item list, so include every item.",
      inputSchema: { id: z.string(), ...z.object(mealFields).partial().shape },
    },
    async ({ id, ...patch }) => {
      const meal = await api<Meal>("PATCH", `/meals/${encodeURIComponent(id)}`, patch);
      return text(`Updated: ${summarize(meal)}`);
    },
  );

  server.registerTool(
    "delete_meal",
    {
      title: "Delete meal",
      description: "Delete a logged meal. Confirm with the user first unless they clearly asked.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      await api("DELETE", `/meals/${encodeURIComponent(id)}`);
      return text(`Deleted meal ${id}.`);
    },
  );

  server.registerPrompt(
    "log_meal_from_photo",
    {
      title: "Log a meal from a photo",
      description: "Analyze an attached food photo, ask about anything unclear, then log it.",
      argsSchema: { details: z.string().optional().describe("Anything you already know about the meal") },
    },
    ({ details }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Look at the food photo I've attached and estimate calories and macros for each item. " +
              "If you can't tell what something is, how much there is, or how it was prepared, ask me " +
              "before logging. Then log it with log_meal." +
              (details ? `\n\nDetails: ${details}` : ""),
          },
        },
      ],
    }),
  );

  return server;
}
