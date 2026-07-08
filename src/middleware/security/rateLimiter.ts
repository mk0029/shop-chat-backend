import rateLimit from "express-rate-limit";

export const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please slow down." },
});

export const otpLimiter = rateLimit({
  windowMs: 60_000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many OTP requests. Please slow down." },
});

export const billCreateLimiter = rateLimit({
  windowMs: 10_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many bill creation requests. Please slow down." },
});

export const searchLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many search requests. Please slow down." },
});

export const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many upload requests. Please slow down." },
});

export const waEventLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many event requests. Please slow down." },
});

export const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please slow down." },
});
