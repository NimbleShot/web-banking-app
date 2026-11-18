// GET /__test/outbox?email=…: the latest passcode sent to an email (docs/decisions/0012).
// Test-only: createApp mounts it for the in-memory outbox outside production, ahead of the
// contract, and it is not in api/openapi.yaml.
import { Router } from 'express';
import type { OutboxMailer } from '../mail/outbox';
import { sendProblem, validationProblem } from './problem';

export const TEST_OUTBOX_PATH = '/__test/outbox';

export function createTestOutboxRouter(outbox: OutboxMailer): Router {
  const router = Router();
  router.get(TEST_OUTBOX_PATH, (req, res, next) => {
    const { email } = req.query;
    // A missing, empty or repeated email is a mistake in the caller, not "no message".
    if (typeof email !== 'string' || email === '') {
      sendProblem(
        res,
        validationProblem([{ field: 'email', message: 'must be one email address' }]),
      );
      return;
    }
    const latest = outbox.sentTo(email.toLowerCase()).at(-1);
    // No message: fall through, so the answer is the one an unknown path gets.
    if (latest === undefined) {
      next();
      return;
    }
    res.json({ email: latest.to, purpose: latest.purpose, passcode: latest.passcode });
  });
  return router;
}
