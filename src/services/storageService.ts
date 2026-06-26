import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env";

const CHAT_MEDIA_BUCKET = "chat-media";
const PROFILE_IMAGES_BUCKET = "profile-images";

function getAdminClient() {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return null;
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function deleteFile(filePath: string): Promise<boolean> {
  try {
    const admin = getAdminClient();
    if (!admin) {
      console.warn("[StorageService] Supabase not configured");
      return false;
    }
    const bucket = filePath.startsWith("profile-images/") ? PROFILE_IMAGES_BUCKET : CHAT_MEDIA_BUCKET;
    const { error } = await admin.storage.from(bucket).remove([filePath]);
    if (error) {
      console.warn("[StorageService] Failed to delete file:", filePath, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[StorageService] Error deleting file:", err);
    return false;
  }
}

export async function deleteFiles(filePaths: string[]): Promise<boolean> {
  if (!filePaths.length) return true;
  try {
    const admin = getAdminClient();
    if (!admin) return false;
    const chatPaths = filePaths.filter((p) => !p.startsWith("profile-images/"));
    const profilePaths = filePaths.filter((p) => p.startsWith("profile-images/"));
    let ok = true;
    if (chatPaths.length) {
      const { error } = await admin.storage.from(CHAT_MEDIA_BUCKET).remove(chatPaths);
      if (error) { console.warn("[StorageService] Batch delete failed:", error.message); ok = false; }
    }
    if (profilePaths.length) {
      const { error } = await admin.storage.from(PROFILE_IMAGES_BUCKET).remove(profilePaths);
      if (error) { console.warn("[StorageService] Batch delete failed:", error.message); ok = false; }
    }
    return ok;
  } catch (err) {
    console.warn("[StorageService] Error in batch delete:", err);
    return false;
  }
}

export function extractFilePathFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/storage\/v1\/object\/public\/(?:chat-media|profile-images)\/(.+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function extractFilePathsFromMessage(message: any): string[] {
  const paths: string[] = [];
  if (message.media?.path) paths.push(message.media.path);
  if (Array.isArray(message.attachments)) {
    for (const att of message.attachments) {
      if (typeof att === "object" && att?.path) paths.push(att.path);
    }
  }
  return paths;
}

export async function createSignedUpload(fileName: string, contentType: string) {
  const admin = getAdminClient();
  if (!admin) throw new Error("Supabase not configured");
  const filePath = `chat-uploads/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const { data, error } = await admin.storage
    .from(CHAT_MEDIA_BUCKET)
    .createSignedUploadUrl(filePath);
  if (error) throw new Error(`Failed to create signed upload: ${error.message}`);
  const publicUrl = admin.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(filePath).data.publicUrl;
  return {
    url: data?.signedUrl || null,
    path: filePath,
    publicUrl,
    token: data?.token || null,
  };
}
