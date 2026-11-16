/**
 * Applies pending migrations to DATABASE_URL (Neon).  `npm run db:migrate`
 * Run on deploy, not on app start: no schema queries on cold starts.
 */
import { neonExecutor } from "../lib/server/db/executor";
import { migrate } from "../lib/server/db/migrations";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Without it the app uses the local JSON store and needs no migration.");
  process.exit(1);
}
migrate(neonExecutor(url), (m) => console.log(m))
  .then((ran) => console.log(ran.length ? `applied ${ran.length} migration(s)` : "schema up to date"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
