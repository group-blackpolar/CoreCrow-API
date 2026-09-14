// src/types/fastify.d.ts
import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: string; role: string };
    apiKey?: { id: string; scopes: string[] };
    admin?: { id: string; role: string };
  }
}

// fix
