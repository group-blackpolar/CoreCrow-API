import { z } from "zod";
export const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
});
export const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(2).max(50),
});
export const createApiKeySchema = z.object({
    name: z.string().min(2).max(50),
    scopes: z.array(z.string()).default([]),
});
export const userUpdateSchema = z.object({
    email: z.string().email().optional(),
    name: z.string().min(2).max(50).optional(),
    role: z.enum(["USER", "DEVELOPER", "ADMIN", "SUPERADMIN"]).optional(),
});
export const userCreateSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(2).max(50),
    role: z
        .enum(["USER", "DEVELOPER", "ADMIN", "SUPERADMIN"])
        .optional()
        .default("USER"),
});
