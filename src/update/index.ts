// Updates LunaticFlow from its GitHub releases: a GitHub Action builds the .vsix for each
// version tag and attaches it to a release; this checks for a newer release and, on one
// click, downloads and installs it through VS Code's own extension installer.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { Release, compareVersions, vsixAsset } from './version';

const DAY = 24 * 3600 * 1000;
const LAST_CHECK = 'lunaticflow.update.lastCheck';
const SKIPPED = 'lunaticflow.update.skipped';

/** GET with redirects (release assets redirect to GitHub's object store). VS Code applies its proxy settings to `https`. */
function get(url: string, accept: string, redirects = 5): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'lunaticflow-updater', Accept: accept } }, res => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
                res.resume();
                resolve(get(new URL(res.headers.location, url).toString(), accept, redirects - 1));
                return;
            }
            if (status !== 200) {
                res.resume();
                reject(new Error(`${url} answered ${status}${status === 403 ? ' (GitHub rate limit?)' : ''}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.setTimeout(30_000, () => req.destroy(new Error(`timed out fetching ${url}`)));
        req.on('error', reject);
    });
}

export function activateUpdater(context: vscode.ExtensionContext): void {
    const current: string = context.extension.packageJSON.version;
    const config = () => vscode.workspace.getConfiguration('lunaticflow');
    let busy = false;

    async function latest(): Promise<Release> {
        const repo = config().get<string>('updateRepository', 'mahyarsamani/Tab-Groups');
        const body = await get(`https://api.github.com/repos/${repo}/releases/latest`, 'application/vnd.github+json');
        return JSON.parse(body.toString('utf8')) as Release;
    }

    async function install(release: Release): Promise<void> {
        const asset = vsixAsset(release);
        if (!asset) {
            vscode.window.showWarningMessage(`LunaticFlow ${release.tag_name} has no .vsix attached; install it from the release page.`);
            return;
        }
        const dir = context.globalStorageUri.fsPath;
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, asset.name);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Updating LunaticFlow to ${release.tag_name}` },
            async progress => {
                progress.report({ message: 'downloading…' });
                fs.writeFileSync(file, await get(asset.url, 'application/octet-stream'));
                progress.report({ message: 'installing…' });
                await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
            });
        const pick = await vscode.window.showInformationMessage(
            `LunaticFlow ${release.tag_name} is installed. Reload the window to start using it.`, 'Reload Window');
        if (pick) { await vscode.commands.executeCommand('workbench.action.reloadWindow'); }
    }

    /** `manual`: the user asked, so say when there is nothing new and ignore "skip this version". */
    async function check(manual: boolean): Promise<void> {
        if (busy) { return; }
        busy = true;
        try {
            const release = await latest();
            await context.globalState.update(LAST_CHECK, Date.now());
            const newer = compareVersions(release.tag_name, current) > 0;
            if (!newer) {
                if (manual) { vscode.window.showInformationMessage(`LunaticFlow ${current} is the latest version.`); }
                return;
            }
            if (!manual && context.globalState.get<string>(SKIPPED) === release.tag_name) { return; }
            const pick = await vscode.window.showInformationMessage(
                `LunaticFlow ${release.tag_name.replace(/^v/, '')} is available (you have ${current}).`,
                'Update', 'Release Notes', 'Skip This Version');
            if (pick === 'Update') { await install(release); }
            else if (pick === 'Release Notes') { await vscode.env.openExternal(vscode.Uri.parse(release.html_url)); }
            else if (pick === 'Skip This Version') { await context.globalState.update(SKIPPED, release.tag_name); }
        } catch (e) {
            if (manual) {
                vscode.window.showErrorMessage(`LunaticFlow could not check for updates: ${e instanceof Error ? e.message : e}`);
            }
        } finally {
            busy = false;
        }
    }

    const maybeCheck = () => {
        if (!config().get<boolean>('checkForUpdates', true)) { return; }
        const last = context.globalState.get<number>(LAST_CHECK, 0);
        if (Date.now() - last >= DAY) { void check(false); }
    };
    const first = setTimeout(maybeCheck, 15_000);
    const daily = setInterval(maybeCheck, 3600 * 1000);
    context.subscriptions.push(
        { dispose: () => { clearTimeout(first); clearInterval(daily); } },
        vscode.commands.registerCommand('lunaticflow.checkForUpdates', () => check(true)),
    );
}
