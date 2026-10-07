import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261007080042_route_attempt_hedges_and_bodies",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`route_attempt\` ADD \`error_body\` text;`)
      yield* tx.run(`ALTER TABLE \`route_attempt\` ADD \`hedged\` integer;`)
    })
  },
}

export default migration
