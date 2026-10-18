import "dotenv/config";
import { asAtUriString, isDidString } from "@atproto/lex";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

const [command, subject, targetDid] = process.argv.slice(2);
const config = loadConfig();
const runtime = createRuntime(config);

try {
  await runtime.store.migrate();
  switch (command) {
    case "migrate":
      break;
    case "collect-once":
      await runtime.orchestrator.bootstrap();
      await runtime.orchestrator.runOnce();
      break;
    case "track-account": {
      if (!subject || !isDidString(subject)) throw new Error("track-account requires a DID");
      const profile = (await runtime.protocol.profiles([subject]))[0];
      if (!profile) throw new Error(`Profile not found for ${subject}`);
      await runtime.store.trackAccount(profile);
      await runtime.store.enqueue("account.profile", subject, new Date(), { did: subject }, 90);
      await runtime.store.enqueue("posts.maintenance", subject, new Date(), { did: subject }, 55);
      // Deliberately NOT enqueueing `audience.followers`. `bootstrap()` stopped
      // auto-scheduling it for the same reason: audience v2 centres on engagers,
      // not lurkers, and a follower sample is real work against the AppView for
      // an account nobody has opted in. Enrolment is not consent — opting in is
      // `enable-audience <did>`, which is also what the premium gate reads.
      //
      // This used to enqueue it whenever AUDIENCE_COLLECTION_ENABLED was set,
      // which is on in production, so a 100-account batch queued 100 follower
      // scans for accounts with `audience_enabled = false`, none of which anyone
      // asked for (2026-09-15).
      break;
    }
    case "disable-account": {
      if (!subject || !isDidString(subject)) throw new Error("disable-account requires a DID");
      // Hard cancellation: disable, cancel the run, and delete queued jobs. A
      // job already leased finishes its bounded slice, then its handler sees the
      // account disabled and drops itself instead of rescheduling.
      await runtime.store.cancelAccount(subject);
      break;
    }
    case "enable-audience": {
      // Opt one account into the engager audience scan (W41; the premium hook).
      // Also enqueues an immediate scan so it starts without a restart — it only
      // runs when AUDIENCE_COLLECTION_ENABLED is on, and the handler self-drops
      // if the flag is cleared.
      if (!subject || !isDidString(subject)) throw new Error("enable-audience requires a DID");
      await runtime.store.setAudienceEnabled(subject, true);
      // Priority 70 matches AUDIENCE_JOB_PRIORITY in the orchestrator: below
      // account post replay (75) and profile (80), above cold maintenance (55).
      await runtime.store.enqueue("account.audience", subject, new Date(), { did: subject }, 70);
      break;
    }
    case "disable-audience": {
      // Opt one account out of audience collection. The standing scan self-
      // terminates on its next run (it checks the flag); this does not touch
      // already-collected audience rows.
      if (!subject || !isDidString(subject)) throw new Error("disable-audience requires a DID");
      await runtime.store.setAudienceEnabled(subject, false);
      break;
    }
    case "reset-trial": {
      // Operator escape hatch for premium/trial state (auth.app_user, migration
      // 022). Clears the trial window so the account can activate again — the one
      // thing first-activation-wins otherwise forbids, on purpose. Use it to
      // re-trial an account whose window was consumed by testing, or to make good
      // on a support request; it is never automatic.
      if (!subject || !isDidString(subject)) throw new Error("reset-trial requires a DID");
      const reset = await runtime.store.resetTrial(subject);
      if (!reset) throw new Error(`No user row for ${subject} — nothing to reset`);
      break;
    }
    case "grant-premium": {
      // Operator grant of a permanent premium entitlement (auth.app_user,
      // migration 022). `status = 'active'` is the state every premium check
      // already reads as live with no expiry, so this is the comp path while
      // real billing does not exist. `reset-trial <did>` is the way back: it
      // clears the window and returns the row to 'none'.
      if (!subject || !isDidString(subject)) throw new Error("grant-premium requires a DID");
      const granted = await runtime.store.grantPremium(subject);
      if (!granted) throw new Error(`No user row for ${subject} — nothing to grant`);
      break;
    }
    case "track-post": {
      if (!subject) throw new Error("track-post requires an AT URI");
      const uri = asAtUriString(subject);
      const post = (await runtime.protocol.posts([uri]))[0];
      if (!post) throw new Error(`Post not found for ${uri}`);
      let accountDid: (typeof post)["authorDid"] | undefined;
      if (targetDid) {
        if (!isDidString(targetDid)) throw new Error("optional audience target must be a DID");
        if (targetDid !== post.authorDid) {
          throw new Error("audience target must be the post author");
        }
        const profile = (await runtime.protocol.profiles([targetDid]))[0];
        if (!profile) throw new Error(`Profile not found for ${targetDid}`);
        await runtime.store.trackAccount(profile);
        accountDid = targetDid;
      }
      await runtime.store.upsertPost(post, "explicit", accountDid);
      await runtime.store.enqueue("post.metrics", uri, new Date(), {
        uri,
        explicit: true,
        unchangedRuns: 0,
      }, 90);
      if (targetDid && config.audienceCollectionEnabled) {
        await runtime.store.enqueue("post.engagers", uri, new Date(), {
          uri,
          targetDid,
          createdAt: post.createdAt,
        }, 70);
      }
      break;
    }
    default:
      throw new Error(
        "Usage: migrate | collect-once | track-account <did> | disable-account <did> | enable-audience <did> | disable-audience <did> | reset-trial <did> | grant-premium <did> | track-post <at-uri> [target-did]",
      );
  }
} finally {
  await runtime.store.close();
}
