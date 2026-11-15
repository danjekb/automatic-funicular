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

# Dodanie nowego modelu (np. OpenAI, Groq, Ollama, OpenRouter)
agy-models add --id "gpt-4o" --name "GPT-4o" --provider openai --base-url "https://api.openai.com/v1" --api-key "sk-..."

# Dodanie modelu z lokalnego gatewaya / llama.cpp / vLLM
agy-models add --id "deepseek-coder" --name "DeepSeek Coder 33B" --provider openai --base-url "http://127.0.0.1:8000/v1"

# Usunięcie modelu
agy-models remove gpt-4o

# Restart proxy
agy-models restart
```

---

## 3. Struktura Plików

- `env/overlay/lib/model_proxy/` – silnik proxy uruchamiany przez Node.js, zawierający adapter `electron-log` pod Androida.
- `env/overlay/bin/agy-models` – CLI do konfiguracji `custom_models.json`.
- `app/src/main/java/dev/singularity/antigravity/core/CoreServerService.java` – automatyczny start/stop serwera proxy wraz z aplikacją.
- `web/src/core/fetch-rewrite.js` – hook przekierowujący `LanguageServerService/SetCloudCodeURL`.
- `integrate_gateway.sh` – skrypt automatyzujący ponowną synchronizację lub aktualizację proxy z repozytorium upstream.
