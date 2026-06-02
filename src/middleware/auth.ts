import type { NextFunction, Request, Response } from "express";
import { extractAuthStorageFromHeaders, isAdmin, isCustomer, verifyShopAuth } from "../services/shopAuth";
import type { ShopUser } from "../types/auth";

export type AuthRequest = Request & {
  shopUser?: ShopUser;
};

export async function requireShopAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const raw = extractAuthStorageFromHeaders(req.headers as Record<string, unknown>);
    const user = await verifyShopAuth(raw);
    if (!user) return res.status(401).json({ message: "Unauthorized" });
    req.shopUser = user;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.shopUser || !isAdmin(req.shopUser)) {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
}

export function requireCustomer(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.shopUser || !isCustomer(req.shopUser)) {
    return res.status(403).json({ message: "Customer access required" });
  }
  next();
}
