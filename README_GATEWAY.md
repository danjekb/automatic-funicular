# Singularity Multi-Model Gateway & Proxy Integration

Ten moduł integruje lekki, lokalny serwer proxy (`model_proxy`) w aplikacji Singularity na Androida, oparty o architekturę z projektu [antigravity-add-model](https://github.com/vahapogut/antigravity-add-model).

> **Ważne:** bramka na portach `45170 / 45171` (`SystemGatewayServer` / `GatewayDispatcher`) to bramka poleceń platformy Android (`notify`, `open_url`, `wakelock`, `clipboard`, `exec`). Nie zawiera i nie zawierała żadnej warstwy tłumaczenia formatów modeli.
>
> Cała komunikacja z modelami custom przechodzi przez `model_proxy` (port `50998`) i jest to **czysty pass-through**. Tłumaczenie formatów i schematów wykonuje zewnętrzny serwer (np. FreeLLMAPI) — Singularity nie konwertuje już niczego lokalnie.

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
|   - Lista modeli: natywne + zapisane modele custom                |
|   - Model custom: surowy pass-through (body, nagłówki, query)     |
|   - Brak translatorów, brak normalizacji schematów                |
+-------------------------------------------------------------------+
                                  |
                                  | 3. Te same bajty żądania
                                  v
                    [ FreeLLMAPI / własny endpoint ]
                    (tłumaczy format i zwraca odpowiedź)
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
   - Dzięki temu zapytania o listę modeli i generowanie treści trafiają przez proxy bez modyfikowania binarki silnika.

3. **Warstwa transportu (pass-through):**
   - Model custom jest rozpoznawany po nazwie/aliasie z `custom_models.json`, a następnie żądanie jest przekazywane **bez zmian** do `apiUrl` tego modelu.
   - Przekazywane jest: oryginalne body (bajt w bajt), ścieżka/query (gdy `apiUrl` to samo origin) oraz nagłówki wejściowe.
   - Nagłówki `authorization`, `x-api-key`, `x-goog-api-key` pochodzące z IDE są **usuwane** i zastępowane kluczem skonfigurowanym dla modelu (`Authorization: Bearer <apiKey>`); `customHeaders` są dodawane na końcu.
   - Odpowiedź upstreamu jest strumieniowana bez buforowania: status, nagłówki, body i ramkowanie SSE wracają dokładnie takie, jakie wysłał endpoint.
   - Brak retry/fallbacku i brak kopert `{ response, traceId, metadata }` — endpoint jest właścicielem formatu.

4. **Wpis „Auto (router picks the best model…)” w wyborze modelu:**
   - To natywny wpis Google — jego identyfikator nie pasuje do żadnego zapisanego modelu, więc wcześniej każde takie żądanie leciało do Cloud Code (Google) i **nigdy** nie trafiało do FreeLLMAPI.
   - Proxy uczy się identyfikatorów tego wpisu z katalogu modeli (`fetchAvailableModels`) i kieruje wybór „Auto” do zapisanego modelu: oznaczonego polem `"autoTarget": true`, a gdy takie oznaczenie nie istnieje — do jedynego włączonego modelu.
   - W treści żądania pole `model` jest zamieniane na `externalModelName` zapisanego modelu, bo endpoint nie zna natywnych identyfikatorów Google.
   - Gdy zapisanych jest kilka modeli i żaden nie ma `autoTarget`, Auto pozostaje natywne (żądanie idzie do Google), a w `proxy.log` pojawia się ostrzeżenie.

5. **Formaty i providerzy:**
   - `providers.js` zawiera preset `free-llm-api` z `apiFormat: "passthrough"`.
   - Format `passthrough` jest akceptowany przez walidator konfiguracji i widoczny w formularzu modelu („Pass-through (no gateway translation)”).
   - Nie ma żadnych sprawdzeń silnika/providera, które blokowałyby model kierowany do FreeLLMAPI.

---

## 2. Zarządzanie Modelami z CLI (`agy-models`)

Do zarządzania modelami dodano narzędzie CLI w `env/overlay/bin/agy-models`:

```bash
# Status proxy i zarejestrowane modele
agy-models status
agy-models list

# FreeLLMAPI: endpoint sam tłumaczy format, więc używamy presetu pass-through
agy-models set-url custom http://127.0.0.1:8080/v1/raw
agy-models set-key custom freellmapi-...

# Dodanie modelu z lokalnego gatewaya / llama.cpp / vLLM (pass-through)
agy-models add --id "deepseek-coder" --name "DeepSeek Coder 33B" --provider free-llm-api --base-url "http://127.0.0.1:8000/v1/raw"

# Usunięcie modelu
agy-models remove gpt-4o

# Restart proxy
agy-models restart
```

Konfiguracja modeli (base URL, klucz API, identyfikator modelu) pozostaje w `custom_models.json` i w panelu modeli WebView — refaktor nie zmienił formatu pliku ani UI poza dodaniem opcji `passthrough`.

---

## 3. Struktura Plików

- `env/overlay/lib/model_proxy/` – silnik proxy uruchamiany przez Node.js, zawierający adapter `electron-log` pod Androida.
  - `proxy/proxy/passthrough.js` – **jedyny** transport modeli custom: surowe przekazywanie HTTP/SSE.
  - `proxy/proxy/customRequest.js` – cienki alias eksportów pass-through (kompatybilność z probe/delegacją).
  - `proxy/proxy.js` – routing: lista modeli, rozpoznanie modelu custom → pass-through, natywny Google forwarding bez zmian.
  - `proxy/providers.js`, `proxy/schemaValidator.js`, `proxy/customPreload.js` – presety, walidacja i formularz modeli.
- `env/overlay/bin/agy-models` – CLI do konfiguracji `custom_models.json`.
- `app/src/main/java/dev/singularity/antigravity/core/CoreServerService.java` – automatyczny start/stop serwera proxy wraz z aplikacją.
- `web/src/core/fetch-rewrite.js` – hook przekierowujący `LanguageServerService/SetCloudCodeURL`.
- `modules/gateway/tests/` – testy pass-through (surowe body/nagłówki/query/SSE, brak modułów tłumaczących).
- `integrate_gateway.sh` – skrypt automatyzujący ponowną synchronizację proxy z repozytorium upstream; celowo **nie** przywraca translatorów ani nie nadpisuje transportu pass-through.

---

## 4. Czego celowo nie ruszamy

- Natywny silnik `language_server` (Bionic/Glibc, loadery, shimy) — bez zmian.
- OAuth i konta Google — bez zmian.
- Rdzeń Android runtime — bez zmian.
- Natywny forwarding Google (`forwardToGoogle`, pula kont Cloud Code) — bez zmian; pass-through dotyczy wyłącznie modeli custom.
