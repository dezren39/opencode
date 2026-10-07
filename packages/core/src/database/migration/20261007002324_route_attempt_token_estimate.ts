import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261007002324_route_attempt_token_estimate",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`route_attempt\` ADD \`tokens_estimated\` integer;`)
    })
  },
}

export default migration
