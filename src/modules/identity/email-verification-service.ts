import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { auditRepository } from "../audit/repository.js";
import { sendVerificationCodeMail } from "../security/mail.js";
import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { emailVerificationRepository as repository } from "./email-verification-repository.js";

const EXPIRY_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const INVALID_CODE = "INVALID_OR_EXPIRED_VERIFICATION_CODE";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function codeHash(email: string, code: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("Identity verification is not configured");
  return createHmac("sha256", secret)
    .update(`email-verification:${email}:${code}`)
    .digest("hex");
}

function matchesHash(expected: string, candidate: string) {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(candidate, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function issueEmailVerificationCode(emailInput: string) {
  const email = normalizeEmail(emailInput);
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const hash = codeHash(email, code);
  const expiresAt = new Date(Date.now() + EXPIRY_MS);
  const recipient = await transaction(async (tx) => {
    const user = await repository.userByEmail(tx, email);
    if (!user || user.emailVerified) return null;
    const challenge = await repository.replaceChallenge(tx, {
      userId: user.id,
      codeHash: hash,
      expiresAt,
    });
    await auditRepository.append(tx, {
      actorId: user.id,
      action: "identity.email_verification.issued",
      targetType: "EmailVerificationChallenge",
      targetId: challenge.id,
    });
    return { email: user.email, name: user.name };
  });
  if (recipient)
    await sendVerificationCodeMail(recipient.email, recipient.name, code);
  return { accepted: true as const };
}

// Public resend remains anti-enumerating even when an address is unknown or
// delivery is temporarily unavailable. Readiness exposes transport health.
export async function requestEmailVerificationCode(emailInput: string) {
  const startedAt = Date.now();
  try {
    await issueEmailVerificationCode(emailInput);
  } catch {
    // The public result intentionally does not reveal account or mail state.
  }
  const remaining = 500 - (Date.now() - startedAt);
  if (remaining > 0)
    await new Promise((resolve) => setTimeout(resolve, remaining));
  return { accepted: true as const };
}

export async function confirmEmailVerificationCode(
  emailInput: string,
  code: string,
) {
  const email = normalizeEmail(emailInput);
  const candidateHash = codeHash(email, code);
  const result = await transaction(async (tx) => {
    const user = await repository.userByEmail(tx, email);
    if (!user || user.emailVerified) {
      await auditRepository.append(tx, {
        actorId: user?.id,
        action: "identity.email_verification.invalid",
        targetType: "EmailVerificationChallenge",
      });
      return false;
    }
    const challenge = await repository.challengeByUser(tx, user.id);
    if (!challenge) {
      await auditRepository.append(tx, {
        actorId: user.id,
        action: "identity.email_verification.invalid",
        targetType: "EmailVerificationChallenge",
      });
      return false;
    }
    if (challenge.expiresAt <= new Date()) {
      await repository.deleteChallenge(tx, challenge.id);
      await auditRepository.append(tx, {
        actorId: user.id,
        action: "identity.email_verification.expired",
        targetType: "EmailVerificationChallenge",
        targetId: challenge.id,
      });
      return false;
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      await repository.deleteChallenge(tx, challenge.id);
      await auditRepository.append(tx, {
        actorId: user.id,
        action: "identity.email_verification.attempt_limit",
        targetType: "EmailVerificationChallenge",
        targetId: challenge.id,
      });
      return false;
    }
    if (!matchesHash(challenge.codeHash, candidateHash)) {
      const updated = await repository.incrementAttempts(tx, challenge.id);
      await auditRepository.append(tx, {
        actorId: user.id,
        action:
          updated.attempts >= MAX_ATTEMPTS
            ? "identity.email_verification.attempt_limit"
            : "identity.email_verification.invalid",
        targetType: "EmailVerificationChallenge",
        targetId: challenge.id,
      });
      return false;
    }
    await repository.verifyUser(tx, user.id);
    await repository.deleteChallenge(tx, challenge.id);
    await auditRepository.append(tx, {
      actorId: user.id,
      action: "identity.email_verification.confirmed",
      targetType: "User",
      targetId: user.id,
    });
    return true;
  });
  if (!result)
    fail(400, INVALID_CODE, "The verification code is invalid or expired");
  return { verified: true as const };
}

export const emailVerificationPolicy = {
  expirySeconds: EXPIRY_MS / 1000,
  maxAttempts: MAX_ATTEMPTS,
};
