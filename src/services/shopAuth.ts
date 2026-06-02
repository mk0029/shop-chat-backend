import { parse as parseCookie } from "cookie";
import { sanityClient } from "../config/sanity";
import type { AuthPayload, ShopRole, ShopUser } from "../types/auth";

const ADMIN_ROLES = new Set<ShopRole>(["admin", "super_admin", "technician"]);

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function unwrapAuthStorage(raw: string): AuthPayload | null {
  if (!raw) return null;
  const candidates = [raw];
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {}
  try {
    candidates.push(decodeBase64Url(raw));
  } catch {}

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const state = parsed?.state ?? parsed;
      if (state && typeof state === "object") {
        return {
          user: state.user ?? null,
          role: state.role ?? state.user?.role ?? null,
          isAuthenticated: Boolean(state.isAuthenticated),
        };
      }
    } catch {}
  }

  return null;
}

export function extractAuthStorageFromHeaders(headers: Record<string, unknown>) {
  const direct = headers["x-shop-auth"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^ShopAuth\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }

  const rawCookie = headers.cookie;
  if (typeof rawCookie === "string") {
    const parsed = parseCookie(rawCookie);
    if (parsed["auth-storage"]) return parsed["auth-storage"];
  }

  return "";
}

export async function verifyShopAuth(rawAuthStorage: string): Promise<ShopUser | null> {
  const payload = unwrapAuthStorage(rawAuthStorage);
  if (!payload?.isAuthenticated || !payload.user) return null;

  const rawUser = payload.user;
  const id = String(rawUser.id || rawUser._id || "");
  const customerId = rawUser.customerId ? String(rawUser.customerId) : "";
  if (!id && !customerId) return null;

  const query = `*[_type == "user" && (_id == $id || customerId == $customerId)][0]{
    _id, customerId, name, email, phone, location, role,
    "isActive": select(defined(isActive) => isActive, true)
  }`;
  const sanityUser = await sanityClient.fetch(query, { id, customerId });
  if (!sanityUser || sanityUser.isActive === false) return null;

  const role = String(sanityUser.role || payload.role || rawUser.role || "") as ShopRole;
  if (!role) return null;

  return {
    id: String(sanityUser._id || id),
    customerId: sanityUser.customerId || customerId || null,
    role,
    name: String(sanityUser.name || rawUser.name || role),
    email: sanityUser.email || null,
    phone: sanityUser.phone || null,
    location: sanityUser.location || null,
  };
}

export function isAdmin(user: ShopUser) {
  return ADMIN_ROLES.has(user.role);
}

export function isCustomer(user: ShopUser) {
  return user.role === "customer";
}

export async function getCustomerById(customerId: string): Promise<ShopUser | null> {
  const query = `*[_type == "user" && role == "customer" && (_id == $customerId || customerId == $customerId)][0]{
    _id, customerId, name, email, phone, location, role,
    "isActive": select(defined(isActive) => isActive, true)
  }`;
  const customer = await sanityClient.fetch(query, { customerId });
  if (!customer || customer.isActive === false) return null;
  return {
    id: String(customer._id),
    customerId: customer.customerId || null,
    role: "customer",
    name: String(customer.name || "Customer"),
    email: customer.email || null,
    phone: customer.phone || null,
    location: customer.location || null,
  };
}

export async function listAdminParticipants() {
  const query = `*[_type == "user" && role in ["admin", "super_admin", "technician"] && isActive != false]{
    _id, name, email, phone, role
  } | order(name asc)`;
  const admins = await sanityClient.fetch(query);
  return (Array.isArray(admins) ? admins : []).map((admin: any) => ({
    userId: String(admin._id),
    role: String(admin.role || "admin") === "super_admin" ? "admin" : String(admin.role || "admin"),
    name: String(admin.name || admin.email || "Admin"),
    email: admin.email || null,
    phone: admin.phone || null,
  }));
}
