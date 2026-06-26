import { connectDb } from "../config/db";
import { Room } from "../models/Room";
import { listAdminParticipants } from "../services/shopAuth";

async function backfill() {
  await connectDb();
  console.log("[backfill] Connected to DB");

  const admins = await listAdminParticipants();
  console.log(`[backfill] Found ${admins.length} admin participants`);

  const rooms = await Room.find({}).lean();
  let updated = 0;

  for (const room of rooms) {
    const customerId = String((room as any).customerId);
    const existingParticipants: Array<{ userId: string }> = (room as any).participants || [];
    const existingIds = new Set(existingParticipants.map((p) => p.userId));

    // Ensure customer is in participants
    if (!existingIds.has(customerId)) {
      existingIds.add(customerId);
    }

    // Ensure all current admins are in participants
    const needsUpdate = admins.some((admin) => !existingIds.has(admin.userId));
    if (!needsUpdate) continue;

    const newParticipants = [
      { userId: customerId, role: "customer", name: (room as any).customerName || "Customer" },
      ...admins.filter((admin) => admin.userId !== customerId),
    ];

    await Room.updateOne(
      { _id: room._id },
      { $set: { participants: newParticipants, admins } },
    );
    updated++;
    console.log(`[backfill] Updated room ${room._id} (${(room as any).customerName})`);
  }

  console.log(`[backfill] Done. Updated ${updated} rooms`);
  process.exit(0);
}

backfill().catch((err) => {
  console.error("[backfill] Failed:", err);
  process.exit(1);
});
