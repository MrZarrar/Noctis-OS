// Makes the Devolutions Gateway provisioner key pair for the core (ADR-0035, Task 3.9).
//
//   node scripts/deploy/gateway-key.mjs [directory]     default: %LOCALAPPDATA%\Noctis
//
// The private half stays on the core's machine and signs session tokens; point
// NOCTIS_GATEWAY_PROVISIONER_KEY_FILE at it. The public half is printed so it
// can be pasted into the Gateway's provisioner.pem on each target host. It never
// overwrites: a replaced private key would silently invalidate every Gateway
// that holds the old public one.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = resolve(
  process.argv[2] ?? join(process.env.LOCALAPPDATA ?? process.cwd(), "Noctis"),
);
const privatePath = join(directory, "gateway-provisioner.key");
const publicPath = join(directory, "gateway-provisioner.pem");

if (existsSync(privatePath) || existsSync(publicPath)) {
  process.stderr.write(
    `A Gateway key pair already exists in ${directory}. Refusing to overwrite it; delete both files first if rotating on purpose, then re-paste the new public key on every Gateway.\n`,
  );
  process.exit(1);
}

mkdirSync(directory, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx" });
writeFileSync(publicPath, publicPem, { flag: "wx" });

process.stdout.write(
  `Private key (stays here, never copy it): ${privatePath}\nPublic key: ${publicPath}\n\n${publicPem}`,
);
