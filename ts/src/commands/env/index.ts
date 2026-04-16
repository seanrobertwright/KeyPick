// `keypick env` subcommand dispatcher.

import * as push from "./push.ts";
import * as pull from "./pull.ts";
import * as status from "./status.ts";

export type EnvSubcommand = "push" | "pull" | "status";

export async function run(sub: EnvSubcommand): Promise<void> {
  switch (sub) {
    case "push":
      return push.run();
    case "pull":
      return pull.run();
    case "status":
      return status.run();
  }
}
