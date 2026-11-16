# Singularity Multi-Model Gateway & Proxy Integration

Ten moduł integruje lekki, lokalny serwer proxy (`model_proxy`) w aplikacji Singularity na Androida, oparty o architekturę z projektu [antigravity-add-model](https://github.com/vahapogut/antigravity-add-model).

---

## 1. Jak to działa (Architektura)

```
+-------------------------------------------------------------------+
|                        Singularity Webview                        |
+-------------------------------------------------------------------+
                                  |
                                  | 1. Intercept LanguageServer
                                  v
+-------------------------------------------------------------------+
|               web/src/core/fetch-rewrite.js                       |
|               (SetCloudCodeURL -> http://127.0.0.1:50998)          |
+-------------------------------------------------------------------+
                                  |
                                  | 2. Zapytania ConnectRPC/HTTP
                                  v
+-------------------------------------------------------------------+
|               model_proxy (Node.js @ port 50998)                  |
|               env/overlay/lib/model_proxy/entry.js                |
|                                                                   |
|   - Provider Translator (OpenAI, Anthropic, Google, DeepSeek)     |
|   - Param Normalization & DSML Tag Stripping                      |
|   - Reasoning Cache & Replay                                      |
+-------------------------------------------------------------------+
            |                                         |
            | Bezpośrednie API dostawcy               | v1/v1beta
            v                                         v
 [OpenAI / Anthropic / Groq / OpenRouter]     [Lokalny Gateway / LLM]
```

1. **Cykl życia w Androidzie (`CoreServerService.java`):**
   - Po uruchomieniu głównego serwera Singularity, `CoreServerService` w osobnym wątku uruchamia `node entry.js --port 50998`.
   - Zapisuje stan w `$HOME/.gemini/antigravity-app/.ide-proxy/state.json`.
   - Przy niszczeniu serwisu wysyła `SIGTERM (15)` do procesu proxy.

2. **Przekierowanie w warstwie WebView (`fetch-rewrite.js`):**
   - Podczas inicjalizacji klienta gRPC-Web/ConnectRPC, skrypt sprawdza obecność proxy na porcie `50998` (lub `50999`).
   - Wysyła żądanie do wewnętrznego RPC:
     `/exa.language_server_pb.LanguageServerService/SetCloudCodeURL`
     z parametrem `url: "http://127.0.0.1:50998"`.
   - Dzięki temu wszystkie zapytania o listę modeli i autouzupełnianie trafiają przez warstwę tłumaczącą proxy bez modyfikowania binarki silnika.

3. **Warstwa tłumacząca (Translators):**
   - Mapuje format Gemini/CloudCode na docelowe schematy API OpenAI, Anthropic, Claude i DeepSeek.
   - Obsługuje normalizację schematów narzędzi (`type: [string, null]` -> formaty akceptowane przez docelowe API).
   - Oczyszcza i przekazuje myślenie modeli (`reasoning_content` / `thought`) dzięki modułowi `reasoningReplay.js`.

---

## 2. Zarządzanie Modelami z CLI (`agy-models`)

Do zarządzania modelami dodano narzędzie CLI w `env/overlay/bin/agy-models`:

```bash
# Status proxy i zarejestrowane modele
agy-models status
agy-models list

# Automatyczne wykrycie i synchronizacja darmowych modeli OpenCode Zen v2 (wraz z łańcuchem fallbackModels)
agy-models sync-zen
agy-models sync-zen --key <opcjonalny_klucz_zen>

# Konfiguracja klucza i URL dla providera
agy-models set-key <provider_id> <api_key>
agy-models set-url <provider_id> <base_url>

# Włączenie / wyłączenie providera
agy-models enable <provider_id>
agy-models disable <provider_id>
```

---

## 3. Wbudowany Silnik OpenCode Zen v2 (`zen-engine.js`)

W `env/overlay/lib/model_proxy/proxy/proxy/zen/` zintegrowano bezgłowy (headless) adapter protokołu OpenCode Zen v2 (`zen-engine.js`), eliminujący potrzebę uruchamiania zewnętrznego `zen-proxy`:
- **Tożsamość i rotacja sesji v2:** generowanie znaczników `ses_<negated_timestamp_hex><base62>` na 4 nagłówkach sesyjnych (`x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`, `x-session-id`), parowanie z 40-znakowym SHA-1 `x-opencode-project` rotowanym co 30 minut oraz nagłówkami W3C `b3`/`traceparent`.
- **Gate Bypass (Preamble + Tool Manifest):** automatyczne wstrzykiwanie `agent-preamble.txt` do wiadomości systemowej oraz manifestu `agent-tools.json` na początek tablicy `tools[]`, z dwukierunkowym mapowaniem wywołań narzędzi OpenCode (`read`, `edit`, `write`, `shell`, `grep`, `glob`, `list`) na natywne narzędzia Antigravity LanguageServer (`view_file`, `replace_file_content`, `write_to_file`, `run_command`, `grep_search`, `list_dir`, `find_by_name`).
- **Translacja Responses API (`/v1/responses`):** automatyczne kierowanie modeli `gpt-5*`, `gpt-6*`, `grok-*`, `muse-spark-*` na `/inference/openai/v1/responses` i konwersja strumienia SSE w locie do standardowych chunków OpenAI.

---

## 4. Struktura Plików

- `env/overlay/lib/model_proxy/` – silnik proxy uruchamiany przez Node.js (`port 50996`), zawierający adapter `electron-log` pod Androida.
- `env/overlay/lib/model_proxy/proxy/proxy/zen/` – natywny silnik OpenCode Zen v2 (`zen-engine.js`, `agent-preamble.txt`, `agent-tools.json`, `models.json`).
- `env/overlay/bin/agy-models` – CLI do konfiguracji `custom_models.json` oraz synchronizacji katalogu Zen (`sync-zen`).
- `app/src/main/java/dev/singularity/antigravity/core/CoreServerService.java` – automatyczny start/stop serwera proxy wraz z aplikacją.
- `web/src/core/fetch-rewrite.js` – hook przekierowujący `LanguageServerService/SetCloudCodeURL`.
- `integrate_gateway.sh` – skrypt automatyzujący ponowną synchronizację lub aktualizację proxy z repozytorium upstream.
