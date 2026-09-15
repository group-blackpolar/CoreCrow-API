import { prisma } from "../../lib/database.js";
import { auditRepository } from "../audit/repository.js";
import { sendContactNotification } from "../security/mail.js";

const maxAttempts = 5;
const staleClaimMilliseconds = 10 * 60 * 1000;

function safeErrorCode(error: unknown) {
  const candidate =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "DELIVERY_FAILED";
  return /^[A-Z0-9_]{1,40}$/.test(candidate)
    ? candidate
    : "DELIVERY_FAILED";
}

export async function processOneContactNotification(now = new Date()) {
  const recipient = process.env.CONTACT_NOTIFICATION_TO;
  if (!recipient) return false;

  await prisma.contactRequest.updateMany({
    where: {
      notificationStatus: "processing",
      notificationClaimedAt: {
        lt: new Date(now.getTime() - staleClaimMilliseconds),
      },
    },
    data: {
      notificationStatus: "failed",
      notificationClaimedAt: null,
      notificationNextAttemptAt: now,
      notificationLastErrorCode: "STALE_CLAIM",
    },
  });

  const contact = await prisma.contactRequest.findFirst({
    where: {
      notificationStatus: { in: ["pending", "failed"] },
      notificationAttempts: { lt: maxAttempts },
      notificationNextAttemptAt: { lte: now },
    },
    orderBy: { notificationNextAttemptAt: "asc" },
  });
  if (!contact) return false;

  const claim = await prisma.contactRequest.updateMany({
    where: {
      id: contact.id,
      notificationStatus: { in: ["pending", "failed"] },
      notificationAttempts: contact.notificationAttempts,
    },
    data: {
      notificationStatus: "processing",
      notificationClaimedAt: now,
      notificationAttempts: { increment: 1 },
      notificationLastErrorCode: null,
    },
  });
  if (!claim.count) return true;

  try {
    await sendContactNotification(recipient, contact);
    await prisma.$transaction(async (tx) => {
      await tx.contactRequest.update({
        where: { id: contact.id },
        data: {
          notificationStatus: "sent",
          notificationClaimedAt: null,
          notificationNextAttemptAt: null,
          notificationSentAt: new Date(),
          notificationLastErrorCode: null,
        },
      });
      await auditRepository.append(tx, {
        action: "contact.notification.sent",
        targetType: "ContactRequest",
        targetId: contact.id,
      });
    });
  } catch (error) {
    const attempt = contact.notificationAttempts + 1;
    const retryDelaySeconds = Math.min(3600, 30 * 2 ** (attempt - 1));
    await prisma.$transaction(async (tx) => {
      await tx.contactRequest.update({
        where: { id: contact.id },
        data: {
          notificationStatus: "failed",
          notificationClaimedAt: null,
          notificationNextAttemptAt:
            attempt < maxAttempts
              ? new Date(now.getTime() + retryDelaySeconds * 1000)
              : null,
          notificationLastErrorCode: safeErrorCode(error),
        },
      });
      await auditRepository.append(tx, {
        action: "contact.notification.failed",
        targetType: "ContactRequest",
        targetId: contact.id,
      });
    });
  }
  return true;
}

export function startContactNotificationWorker(
  reportError: (error: unknown) => void,
  intervalMilliseconds = 10_000,
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (let processed = 0; processed < 10; processed += 1)
        if (!(await processOneContactNotification())) break;
    } catch (error) {
      reportError(error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMilliseconds);
  timer.unref();
  return () => clearInterval(timer);
}
