import { supabase } from "./supabaseClient";

const num = (value) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();

  if (error) throw error;
  if (!data.user) throw new Error("You are not logged in.");

  return data.user;
}

export async function loadCloudData() {
  const user = await getCurrentUser();

  const [dailyResult, bulkResult, settingsResult] = await Promise.all([
    supabase
      .from("daily_entries")
      .select("*")
      .eq("user_id", user.id)
      .order("entry_date", { ascending: false }),

    supabase
      .from("bulk_orders")
      .select("*")
      .eq("user_id", user.id)
      .order("order_date", { ascending: false }),

    supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (dailyResult.error) throw dailyResult.error;
  if (bulkResult.error) throw bulkResult.error;
  if (settingsResult.error) throw settingsResult.error;

  const entries = {};

  for (const row of dailyResult.data || []) {
    entries[row.entry_date] = {
      revenue: num(row.revenue),
      cost: num(row.cost),
      profit: num(row.profit),
      tax: num(row.tax),
      items: Array.isArray(row.items) ? row.items : [],
      noSale: Boolean(row.no_sale),
    };
  }

  const bulkOrders = (bulkResult.data || []).map((row) => {
    const raw = row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};

    return {
      ...raw,
      id: row.id,
      date: row.order_date,
      club: row.club || raw.club || "",
      items: row.items || raw.items || "",
      qty: row.qty || raw.qty || "",
      revenue: num(row.revenue),
      cost: num(row.cost),
      profit: num(row.profit),
      status: row.status || raw.status || "Paid",
      notes: row.notes || raw.notes || "",
    };
  });

  return {
    user,
    entries,
    bulkOrders,
    goalAmount: num(settingsResult.data?.goal_amount || 5000),
  };
}

export async function saveDailyEntries(entries) {
  const user = await getCurrentUser();

  const rows = Object.entries(entries || {}).map(([date, data]) => ({
    user_id: user.id,
    entry_date: date,
    revenue: num(data.revenue),
    cost: num(data.cost),
    profit: num(data.profit),
    tax: num(data.tax),
    items: Array.isArray(data.items) ? data.items : [],
    no_sale: Boolean(data.noSale),
    updated_at: new Date().toISOString(),
  }));

  const deleteResult = await supabase
    .from("daily_entries")
    .delete()
    .eq("user_id", user.id);

  if (deleteResult.error) throw deleteResult.error;

  if (rows.length === 0) return;

  const insertResult = await supabase
    .from("daily_entries")
    .insert(rows);

  if (insertResult.error) throw insertResult.error;
}

export async function saveBulkOrders(bulkOrders) {
  const user = await getCurrentUser();

  const rows = (bulkOrders || [])
    .filter((order) => order.date)
    .map((order) => ({
      user_id: user.id,
      order_date: order.date,
      club: order.club || "",
      items: order.items || "",
      qty: String(order.qty || ""),
      revenue: num(order.revenue),
      cost: num(order.cost),
      profit: num(order.profit),
      status: order.status || "Paid",
      notes: order.notes || "",
      raw_data: order,
      updated_at: new Date().toISOString(),
    }));

  const deleteResult = await supabase
    .from("bulk_orders")
    .delete()
    .eq("user_id", user.id);

  if (deleteResult.error) throw deleteResult.error;

  if (rows.length === 0) return;

  const insertResult = await supabase
    .from("bulk_orders")
    .insert(rows);

  if (insertResult.error) throw insertResult.error;
}

export async function saveGoalAmount(goalAmount) {
  const user = await getCurrentUser();
  const amount = num(goalAmount);

  if (amount <= 0) return;

  const result = await supabase
    .from("user_settings")
    .upsert({
      user_id: user.id,
      goal_amount: amount,
      updated_at: new Date().toISOString(),
    });

  if (result.error) throw result.error;
}