import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "./api.ts";

function resolveTimezone(): string {
  const tz = process.env.TIMEZONE?.trim();
  if (!tz) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    console.warn(`TIMEZONE "${tz}" is not a valid IANA time zone (e.g. America/New_York); using UTC`);
    return "UTC";
  }
}

const TIMEZONE = resolveTimezone();

const INSTRUCTIONS = `
This server logs meals, workouts and weigh-ins to the user's personal tracker. You are the estimator:
there is no food or exercise database.

MEALS: when the user shares a photo or description of food:

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

WORKOUTS: when the user tells you about exercise they did:

1. Call get_my_stats for their sex, age, height and weight, and base the calorie burn on those
   (e.g. MET value for the activity and intensity × body weight × duration).
2. If the activity, duration or intensity is unclear, ask first (e.g. how long, how hard,
   distance or pace, weights vs. circuits). Batch questions in one message.
3. Call log_workout, recording assumptions and an honest confidence.
4. A quarter (25%) of burned calories is added to that week's calorie allotment; the daily goal
   does not change. log_workout returns the updated weekly numbers. Burn estimates run high, so
   never suggest eating back more than that 25%.

WEIGHT: when the user tells you their weight, call log_weight with the number exactly as
given (decimals are fine) and its unit. Their latest weigh-in automatically updates the weight
used for their calorie targets.

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

const workoutFields = {
  title: z.string().describe("Short name, e.g. 'Morning run' or 'Upper body lifting'"),
  type: z.enum(["run", "walk", "hike", "cycle", "swim", "strength", "hiit", "yoga", "sports", "cardio", "other"]),
  duration_min: z.number().positive().describe("Duration in minutes"),
  intensity: z.enum(["light", "moderate", "hard"]),
  calories_burned: num.describe("Your estimate of calories burned, based on the user's stats from get_my_stats"),
  distance: z.string().optional().describe("If relevant, e.g. '3.1 mi' or '5 km'"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(`Local date, YYYY-MM-DD. Defaults to today (${TIMEZONE}).`),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe("Local start time, 24h HH:MM, if known"),
  confidence: z.enum(["low", "medium", "high"]).describe("How confident the estimate is"),
  assumptions: z
    .array(z.string())
    .optional()
    .describe("Assumptions behind the estimate, e.g. 'Assumed ~10 min/mile pace'"),
  notes: z.string().optional(),
};

type Workout = {
  id: string;
  date: string;
  time?: string;
  title: string;
  type: string;
  duration_min: number;
  intensity: string;
  calories_burned: number;
  distance?: string;
};

type Weight = { id: string; date: string; time?: string; weight_kg: number; note?: string };

const KG_PER_LB = 0.45359237;
const round1 = (n: number) => Math.round(n * 10) / 10;
const fmtWeight = (kg: number) => `${round1(kg / KG_PER_LB)} lb (${round1(kg)} kg)`;

const summarizeWorkout = (w: Workout) =>
  `${w.title} (${w.type}, ${w.date}${w.time ? " " + w.time : ""}) — ${w.duration_min} min, ${w.intensity}` +
  `${w.distance ? `, ${w.distance}` : ""}, ~${w.calories_burned} kcal burned [id ${w.id}]`;

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
type Profile = {
  sex: string;
  age: number;
  height_cm: number;
  weight_kg: number;
  activity: string;
  week_start?: "monday" | "sunday";
};
type ProfileResponse = { profile: Profile | null; targets: (Targets & { bmr: number }) | null };

// Share of workout burn added back to the weekly allotment; must match EAT_BACK in the web app.
const EAT_BACK = 0.25;

const shiftDay = (date: string, by: number) =>
  new Date(Date.parse(date + "T12:00:00Z") + by * 86400000).toISOString().slice(0, 10);

/** Calories/macros left for the day and week containing `date`, or a note that no goals are set. */
async function progress(date: string): Promise<string> {
  const { profile, targets } = await api<ProfileResponse>("GET", "/profile");
  if (!targets) return "No calorie goals set yet; the user can set them on the website's Goals tab.";

  const startDow = profile?.week_start === "sunday" ? 0 : 1;
  const weekStart = shiftDay(date, -((new Date(date + "T12:00:00Z").getUTCDay() - startDow + 7) % 7));
  const weekEnd = shiftDay(weekStart, 6);
  const [{ meals }, { workouts }] = await Promise.all([
    api<{ meals: Meal[] }>("GET", `/meals?from=${weekStart}&to=${weekEnd}`),
    api<{ workouts: Workout[] }>("GET", `/workouts?from=${weekStart}&to=${weekEnd}`),
  ]);

  const sum = (list: Meal[], k: keyof Totals) => Math.round(list.reduce((a, m) => a + m.totals[k], 0));
  const day = meals.filter((m) => m.date === date);
  const left = (goal: number, eaten: number) =>
    goal - eaten >= 0 ? `${goal - eaten} left` : `${eaten - goal} over`;

  // Workouts up to and including this day add a share of their burn to the week.
  const burned = workouts.filter((w) => w.date <= date).reduce((a, w) => a + w.calories_burned, 0);
  const earned = Math.round(burned * EAT_BACK);
  const weekGoal = targets.weekly_calories + earned;
  // The day's budget if the rest of the week (this day included) is to land on the weekly allotment.
  const remainingDays = Math.round((Date.parse(weekEnd) - Date.parse(date)) / 86400000) + 1;
  const eatenBefore = sum(meals.filter((m) => m.date < date), "calories");
  const adjusted = Math.max(0, Math.round((weekGoal - eatenBefore) / remainingDays));
  const dayEaten = sum(day, "calories");

  return [
    `Day ${date}: ${sum(day, "calories")} of ${targets.daily_calories} kcal eaten (${left(targets.daily_calories, sum(day, "calories"))}). ` +
      `Protein ${sum(day, "protein_g")}/${targets.protein_g}g, carbs ${sum(day, "carbs_g")}/${targets.carbs_g}g, fat ${sum(day, "fat_g")}/${targets.fat_g}g.`,
    `Adjusted budget for ${date} (weekly allotment spread over the ${remainingDays} day${remainingDays === 1 ? "" : "s"} left): ` +
      `${adjusted} kcal (${left(adjusted, dayEaten)}).`,
    `Week ${weekStart} to ${weekEnd}: ${sum(meals, "calories")} of ${weekGoal} kcal eaten ` +
      `(${left(weekGoal, sum(meals, "calories"))})` +
      (earned ? `; allotment includes +${earned} kcal from workouts (25% of ~${burned} burned).` : "."),
  ].join("\n");
}

const summarize = (m: Meal) =>
  `${m.title} (${m.meal_type}, ${m.date}${m.time ? " " + m.time : ""}) — ${m.totals.calories} kcal, ` +
  `P ${m.totals.protein_g}g · C ${m.totals.carbs_g}g · F ${m.totals.fat_g}g [id ${m.id}]`;

export function createServer(): McpServer {
  const server = new McpServer({ name: "meal-tracker", version: "1.3.0" }, { instructions: INSTRUCTIONS });

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

  server.registerTool(
    "get_my_stats",
    {
      title: "Get my stats",
      description:
        "The user's sex, age, height, weight and activity level from their Goals. Call this before " +
        "estimating calories burned by a workout.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { profile, targets } = await api<ProfileResponse>("GET", "/profile");
      if (!profile) {
        return text(
          "No stats saved yet. Ask the user for their weight (and ideally sex, age and height), or suggest " +
            "they fill in the website's Goals tab.",
        );
      }
      const inches = Math.round(profile.height_cm / 2.54);
      return text(
        [
          `Sex: ${profile.sex}`,
          `Age: ${profile.age}`,
          `Height: ${profile.height_cm} cm (${Math.floor(inches / 12)}'${inches % 12}")`,
          `Weight: ${round1(profile.weight_kg)} kg (${round1(profile.weight_kg / KG_PER_LB)} lb)`,
          `Everyday activity level: ${profile.activity}`,
          targets ? `Resting burn (BMR): ~${targets.bmr} kcal/day` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "log_workout",
    {
      title: "Log workout",
      description:
        "Save a workout with your estimate of calories burned, based on the user's stats (call " +
        "get_my_stats first). Ask about duration or intensity first if they're unclear. 25% of the burn " +
        "is added to that week's calorie allotment; the daily goal doesn't change.",
      inputSchema: workoutFields,
    },
    async (input) => {
      const workout = await api<Workout>("POST", "/workouts", {
        ...input,
        date: input.date ?? nowLocal().date,
        assumptions: input.assumptions ?? [],
      });
      return text(
        `Logged: ${summarizeWorkout(workout)}\n\n${await progress(workout.date)}`,
      );
    },
  );

  server.registerTool(
    "list_workouts",
    {
      title: "List workouts",
      description:
        "List logged workouts with calories burned per day. Use for 'what workouts did I do this week', " +
        "and to find a workout id before updating or deleting.",
      inputSchema: {
        from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive). Defaults to 6 days ago."),
        to: z.string().optional().describe("End date YYYY-MM-DD (inclusive). Defaults to today."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => {
      const today = nowLocal().date;
      const start = from ?? shiftDay(today, -6);
      const end = to ?? today;
      const { workouts } = await api<{ workouts: Workout[] }>(
        "GET",
        `/workouts?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`,
      );
      if (!workouts.length) return text(`No workouts logged between ${start} and ${end}.`);

      const days = new Map<string, Workout[]>();
      for (const w of workouts) days.set(w.date, [...(days.get(w.date) ?? []), w]);
      const total = workouts.reduce((a, w) => a + w.calories_burned, 0);
      const out = [...days].map(([date, ws]) =>
        [
          `${date}: ~${ws.reduce((a, w) => a + w.calories_burned, 0)} kcal burned`,
          ...ws.map((w) => `  - ${summarizeWorkout(w)}`),
        ].join("\n"),
      );
      return text(`${out.join("\n\n")}\n\nTotal ${start} to ${end}: ~${total} kcal burned.`);
    },
  );

  server.registerTool(
    "update_workout",
    {
      title: "Update workout",
      description: "Correct a logged workout (e.g. it was longer, or harder). Pass only the fields to change.",
      inputSchema: { id: z.string(), ...z.object(workoutFields).partial().shape },
    },
    async ({ id, ...patch }) => {
      const workout = await api<Workout>("PATCH", `/workouts/${encodeURIComponent(id)}`, patch);
      return text(`Updated: ${summarizeWorkout(workout)}`);
    },
  );

  server.registerTool(
    "delete_workout",
    {
      title: "Delete workout",
      description: "Delete a logged workout. Confirm with the user first unless they clearly asked.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      await api("DELETE", `/workouts/${encodeURIComponent(id)}`);
      return text(`Deleted workout ${id}.`);
    },
  );

  server.registerTool(
    "log_weight",
    {
      title: "Log weight",
      description:
        "Record a weigh-in. Pass the weight exactly as the user said it (decimals allowed) with its unit. " +
        "The latest weigh-in also updates the weight used for their calorie targets.",
      inputSchema: {
        weight: z.number().positive().describe("e.g. 207.4"),
        unit: z.enum(["lb", "kg"]),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(`Local date, YYYY-MM-DD. Defaults to today (${TIMEZONE}).`),
        note: z.string().optional().describe("Optional, e.g. 'morning, before breakfast'"),
      },
    },
    async ({ weight, unit, date, note }) => {
      const now = nowLocal();
      const day = date ?? now.date;
      const { weights: before } = await api<{ weights: Weight[] }>("GET", "/weights");
      const w = await api<Weight>("POST", "/weights", {
        date: day,
        ...(day === now.date && { time: now.time }),
        weight_kg: unit === "kg" ? weight : weight * KG_PER_LB,
        ...(note && { note }),
      });
      const prev = before.find((b) => b.date <= day && b.id !== w.id);
      const change = prev
        ? `Change since ${prev.date}: ${w.weight_kg - prev.weight_kg > 0 ? "+" : ""}${round1((w.weight_kg - prev.weight_kg) / KG_PER_LB)} lb.`
        : "This is the first weigh-in.";
      return text(`Logged ${fmtWeight(w.weight_kg)} on ${w.date} [id ${w.id}]. ${change}`);
    },
  );

  server.registerTool(
    "list_weights",
    {
      title: "List weigh-ins",
      description: "Weigh-ins over a date range, newest first, with the overall change. Use for weight trend questions.",
      inputSchema: {
        from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive). Defaults to 90 days ago."),
        to: z.string().optional().describe("End date YYYY-MM-DD (inclusive). Defaults to today."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => {
      const today = nowLocal().date;
      const start = from ?? shiftDay(today, -90);
      const end = to ?? today;
      const { weights } = await api<{ weights: Weight[] }>(
        "GET",
        `/weights?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`,
      );
      if (!weights.length) return text(`No weigh-ins between ${start} and ${end}.`);
      const newest = weights[0];
      const oldest = weights.at(-1)!;
      const diff = round1((newest.weight_kg - oldest.weight_kg) / KG_PER_LB);
      return text(
        [
          ...weights.map((w) => `- ${w.date}${w.time ? " " + w.time : ""}: ${fmtWeight(w.weight_kg)}${w.note ? ` (${w.note})` : ""} [id ${w.id}]`),
          "",
          weights.length > 1 ? `Change ${oldest.date} to ${newest.date}: ${diff > 0 ? "+" : ""}${diff} lb.` : "",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "delete_weight",
    {
      title: "Delete weigh-in",
      description: "Delete a weigh-in (e.g. a typo). Confirm with the user first unless they clearly asked.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      await api("DELETE", `/weights/${encodeURIComponent(id)}`);
      return text(`Deleted weigh-in ${id}.`);
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
