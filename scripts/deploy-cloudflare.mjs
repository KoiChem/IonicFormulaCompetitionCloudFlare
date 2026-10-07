import { execFileSync } from 'node:child_process';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Deployment requires a Git commit');
execFileSync('pnpm', ['exec','wrangler','deploy','--var',`RELEASE_SHA:${sha}`], {stdio:'inherit'});
