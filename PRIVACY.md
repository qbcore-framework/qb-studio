# Privacy policy

Last updated: August 30, 2026

This policy describes the privacy behavior of the QB Studio Windows desktop
application distributed from
[`qbcore-framework/qb-studio`](https://github.com/qbcore-framework/qb-studio).

## Summary

QB Studio does not require a QBCore account and does not send analytics,
telemetry, crash reports, project files, or usage data to QBCore Framework.
QBCore Framework does not operate a QB Studio cloud service or user database.

QB Studio is a local development tool. Some features make network requests when
the user invokes them or configures an external service. Installed release
builds also check the public GitHub release feed at startup. Downloading an
application update is always user-initiated, and installing it requires the
user to select **Restart to update**. Opt-in Discord Rich Presence shares a
deliberately narrow activity through the local Discord desktop client and can
be disabled in Settings, as described below.

## Data stored on the device

QB Studio stores application settings in the current Windows user's application
data directory. Those settings can include workspace and executable paths,
the selected server profile and target, artifact update records, and model
provider configuration.

Model-provider API keys are stored separately per named connection using
Electron `safeStorage`, which uses the operating system's protected credential
facilities. Each key is bound to that connection and provider endpoint and is
sent only to that selected endpoint for authentication. Changing an endpoint
does not carry its previously saved key to the new host. Connections marked
keyless never load, store, or send a credential.
Conversation history is held in application memory for the active session and
is not persisted by QB Studio. Imported repositories and user-approved file
changes are stored in the workspace selected by the user.

After the user selects **Download update**, updater metadata and the downloaded
installer can be retained in a local updater cache until installation or cache
cleanup. This cache does not contain project files, model-provider keys, or AI
conversation contents. The updater also stores a random staging identifier in
the application data directory so a future release can use a consistent staged
rollout cohort; it is unrelated to the user's Windows or GitHub identity.

Uninstalling the application might not remove settings retained in the Windows
application data directory. Users can delete that local data manually and can
remove each saved provider key or connection from QB Studio settings.

## Optional AI and model providers

The AI assistant is optional. When a hosted model provider is selected, QB
Studio sends that provider the user's messages and the context required to
answer them. Depending on the task and the user's approvals, this can include
system instructions, selected source code, file contents, file paths, console
output, resource state, tool inputs, and tool results. The provider can also
receive the API key used to authenticate the request, the chosen model name,
and ordinary connection metadata such as the user's IP address.

That information is handled under the selected provider's terms and privacy
policy. QB Studio includes presets for these hosted services:

- [Google privacy policy](https://policies.google.com/privacy)
- [Groq privacy policy](https://groq.com/privacy-policy/)
- [OpenRouter privacy policy](https://openrouter.ai/privacy)
- [Mistral AI privacy policy](https://legal.mistral.ai/terms/privacy-policy)
- [OpenAI privacy policy](https://openai.com/policies/privacy-policy/)
- [Anthropic privacy policy](https://www.anthropic.com/legal/privacy)

Users can instead configure a compatible service running on numeric loopback,
such as Ollama or LM Studio, when model traffic must remain on the local
computer. QB Studio does not control the retention, training, or account
policies of a provider selected by the user.

## Other network features

- **Discord Rich Presence:** Disabled by default and enableable in Settings.
  QB Studio connects to the locally running Discord desktop app without a bot,
  OAuth login, token, or Discord credential. It supplies only the application
  identity and version, the current app area, the broad active target (FiveM
  Legacy, FiveM Enhanced, or RedM), and—while editing or reviewing—the active
  file's basename and a language label derived from its extension. The basename
  is visible to people who can view the user's Discord activity. QB Studio also
  supplies fixed links to `qbcore.org` and its public latest-release page. It
  never supplies full paths, workspace, profile, server or resource names, file
  contents, source selections, console output, Git data, or AI chat contents.
  Discord associates and distributes presence under the user's Discord account
  and the [Discord Privacy Policy](https://discord.com/privacy). Disabling the
  setting clears QB Studio's activity and closes its local Discord connection.
- **QB Studio application updates:** On startup, an installed release requests
  public release metadata from the official GitHub repository. The request does
  not include project files, settings, provider keys, or conversation contents.
  It does include the updater's random persistent staging identifier, which
  supports consistent staged rollout decisions and is not tied to an account.
  No application update is downloaded until the user selects **Download
  update**. That action requests the release metadata, blockmap when applicable,
  and Windows installer from GitHub and stores the downloaded files locally.
  Installation begins only when the user selects **Restart to update**, and is
  blocked while editor tabs have unsaved changes. GitHub receives ordinary
  connection metadata under its privacy statement.
- **GitHub import:** Repository search and metadata requests use GitHub's public
  API. Importing a selected repository invokes Git to download it from GitHub.
  GitHub receives the request and ordinary connection metadata under the
  [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- **Cfx.re artifacts:** When the user checks for or installs a server artifact,
  QB Studio requests metadata and downloads files from official Cfx.re
  endpoints. The downloaded artifact and a local installation record remain on
  the user's computer.
- **External documentation and account links:** These open in the user's
  default browser only after the user selects them. The destination site then
  receives the browser request under its own privacy policy.
- **Local runtime control:** Editor, console, resource lifecycle, RCON, txAdmin,
  and embedded-client coordination are restricted to the user's computer and
  numeric loopback interfaces by QB Studio.

## Data sharing and retention

QBCore Framework does not receive or sell personal information through QB
Studio. Data sent directly to a third-party provider is retained according to
that provider's policies and the user's account settings. Locally stored data
remains until the user changes or deletes it.

## Changes and questions

Material changes to this policy will be committed publicly to the repository.
Privacy questions can be submitted through the
[QB Studio issue tracker](https://github.com/qbcore-framework/qb-studio/issues).
Do not include credentials, private source code, or exploitable security details
in a public issue.
