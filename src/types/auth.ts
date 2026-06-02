export type ShopRole = "admin" | "super_admin" | "technician" | "customer";

export type ShopUser = {
  id: string;
  customerId?: string | null;
  role: ShopRole;
  name: string;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
};

export type AuthPayload = {
  user?: Record<string, unknown> | null;
  role?: ShopRole | null;
  isAuthenticated?: boolean;
};
