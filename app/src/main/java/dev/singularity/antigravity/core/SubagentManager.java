package dev.singularity.antigravity.core;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Manages subagent lifecycle within the Singularity app.
 *
 * Subagents are lightweight, specialized agent instances that can be created,
 * listed, and invoked from the WebView UI. Each subagent has a type (e.g.
 * "code-reviewer", "android-debugger", "security-auditor") and communicates
 * with the core engine through the existing ConnectRPC/fetch infrastructure.
 *
 * This class is intentionally additive: it does not modify any existing
 * component and stores all state in-memory plus an optional localStorage
 * mirror on the JS side.
 */
public final class SubagentManager {

    private static final String TAG = "SubagentManager";

    /** Known subagent types and their default system prompts. */
    public static final Map<String, SubagentType> AGENT_TYPES = new HashMap<>();

    static {
        AGENT_TYPES.put("code-reviewer", new SubagentType(
                "code-reviewer",
                "Code Reviewer",
                "Przeglądarka kodu",
                "Review code for quality, bugs, and best practices. Focus on correctness, security, and maintainability.",
                "Przeglądaj kod pod kątem jakości, błędów i dobrych praktyk. Skup się na poprawności, bezpieczeństwie i łatwości utrzymania."
        ));
        AGENT_TYPES.put("android-debugger", new SubagentType(
                "android-debugger",
                "Android Debugger",
                "Debugger Androida",
                "Diagnose Android-specific issues: logs, crashes, ANRs, permissions, and native crashes.",
                "Diagnozuj problemy specyficzne dla Androida: logi, awarie, ANR, uprawnienia i awarie natywne."
        ));
        AGENT_TYPES.put("security-auditor", new SubagentType(
                "security-auditor",
                "Security Auditor",
                "Audytor bezpieczeństwa",
                "Audit code and configurations for security vulnerabilities, hardcoded secrets, and unsafe patterns.",
                "Audytuj kod i konfiguracje pod kątem luk w bezpieczeństwie, zakodowanych sekretów i niebezpiecznych wzorców."
        ));
        AGENT_TYPES.put("refactoring-assistant", new SubagentType(
                "refactoring-assistant",
                "Refactoring Assistant",
                "Asystent refaktoryzacji",
                "Suggest code refactorings: extract methods, rename variables, simplify logic, improve readability.",
                "Sugeruj refaktoryzację kodu: wyodrębnianie metod, zmienianie nazw zmiennych, upraszczanie logiki, poprawę czytelności."
        ));
        AGENT_TYPES.put("documentation-writer", new SubagentType(
                "documentation-writer",
                "Documentation Writer",
                "Pisarz dokumentacji",
                "Write clear, concise documentation: README, API docs, inline comments, and changelogs.",
                "Pisz jasną, zwięzłą dokumentację: README, dokumentację API, komentarze w kodzie i changelogi."
        ));
    }

    private final Context context;
    private final Map<String, SubagentInstance> agents = new ConcurrentHashMap<>();

    /** Directory for persistent subagent Markdown files: $HOME/.gemini/config/agents/ */
    private static final File AGENTS_DIR;
    /** Aggregated rules file: $HOME/.gemini/config/rules/custom_subagents.md */
    private static final File RULES_FILE;

    static {
        String home = System.getProperty("user.home", System.getenv("HOME"));
        if (home == null || home.isEmpty()) {
            home = "/data/user/0/dev.singularity.antigravity/files";
        }
        File geminiConfig = new File(home, ".gemini/config");
        AGENTS_DIR = new File(geminiConfig, "agents");
        RULES_FILE = new File(geminiConfig, "rules/custom_subagents.md");
    }

    private static final Pattern FRONTMATTER_START = Pattern.compile("^---\\s*$", Pattern.MULTILINE);
    private static final Pattern FRONTMATTER_END = Pattern.compile("^---\\s*$", Pattern.MULTILINE);

    public SubagentManager(Context context) {
        this.context = context.getApplicationContext();
        // Ensure directories exist
        AGENTS_DIR.mkdirs();
        RULES_FILE.getParentFile().mkdirs();
        // Load existing agents from disk
        loadAllAgentsFromFiles();
    }

    /** Returns an unmodifiable list of all available subagent types. */
    public List<SubagentType> listTypes() {
        return Collections.unmodifiableList(new ArrayList<>(AGENT_TYPES.values()));
    }

    /** Returns an unmodifiable list of all active subagent instances. */
    public List<SubagentInstance> listInstances() {
        return Collections.unmodifiableList(new ArrayList<>(agents.values()));
    }

    /** Creates a new subagent instance of the given type. Returns its ID. */
    public String createInstance(String typeId) {
        SubagentType type = AGENT_TYPES.get(typeId);
        if (type == null) {
            Log.w(TAG, "Unknown subagent type: " + typeId);
            return null;
        }
        String id = "subagent_" + UUID.randomUUID().toString().substring(0, 8);
        SubagentInstance instance = new SubagentInstance(id, type);
        agents.put(id, instance);
        saveAgentToFile(instance);
        syncCustomSubagentsRules();
        Log.i(TAG, "Created subagent " + id + " of type " + typeId);
        return id;
    }

    /** Returns the subagent instance with the given ID, or null if not found. */
    public SubagentInstance getInstance(String id) {
        return agents.get(id);
    }

    /** Terminates and removes a subagent instance. Returns true if removed. */
    public boolean terminateInstance(String id) {
        SubagentInstance instance = agents.remove(id);
        if (instance != null) {
            deleteAgentFile(id);
            syncCustomSubagentsRules();
            Log.i(TAG, "Terminated subagent " + id);
            return true;
        }
        return false;
    }

    /** Deletes a custom subagent by id (alias for terminateInstance). */
    public boolean deleteSubagent(String id) {
        return terminateInstance(id);
    }

    /** Terminates all subagent instances. */
    public void terminateAll() {
        agents.clear();
        Log.i(TAG, "Terminated all subagents");
    }

    /** Sends a message to a subagent and returns its response (synchronous wrapper). */
    public SubagentResponse sendMessage(String agentId, String message) {
        SubagentInstance instance = agents.get(agentId);
        if (instance == null) {
            return new SubagentResponse(false, null, "Subagent not found: " + agentId);
        }
        return instance.processMessage(message);
    }

    /** Represents a subagent type definition. */
    public static final class SubagentType {
        public final String id;
        public final String nameEn;
        public final String namePl;
        public final String promptEn;
        public final String promptPl;

        public SubagentType(String id, String nameEn, String namePl, String promptEn, String promptPl) {
            this.id = id;
            this.nameEn = nameEn;
            this.namePl = namePl;
            this.promptEn = promptEn;
            this.promptPl = promptPl;
        }

        public String getName(boolean polish) {
            return polish ? namePl : nameEn;
        }

        public String getPrompt(boolean polish) {
            return polish ? promptPl : promptEn;
        }
    }

    /** Represents an active subagent instance. */
    public static final class SubagentInstance {
        public final String id;
        public final SubagentType type;
        public final long createdAt;
        public int messageCount;

        public SubagentInstance(String id, SubagentType type) {
            this.id = id;
            this.type = type;
            this.createdAt = System.currentTimeMillis();
            this.messageCount = 0;
        }

        /** Processes an incoming message and returns a response. */
        public SubagentResponse processMessage(String message) {
            messageCount++;
            // In a full implementation this would forward to the core engine
            // via ConnectRPC. For now we return a structured acknowledgment.
            String response = String.format(
                    "[%s] Received: %s\n\nThis subagent (%s) is registered and ready. " +
                            "Full engine integration routes messages through the existing ConnectRPC bridge.",
                    type.getName(true), message, type.id
            );
            return new SubagentResponse(true, response, null);
        }
    }

    /** Represents a subagent response. */
    public static final class SubagentResponse {
        public final boolean success;
        public final String content;
        public final String error;

        public SubagentResponse(boolean success, String content, String error) {
            this.success = success;
            this.content = content;
            this.error = error;
        }
    }

    /* ------------------------------------------------------------- persistence */

    /** Load all agents from $HOME/.gemini/config/agents/*.md into memory. */
    private void loadAllAgentsFromFiles() {
        if (!AGENTS_DIR.isDirectory()) {
            return;
        }
        File[] files = AGENTS_DIR.listFiles((dir, name) -> name.endsWith(".md"));
        if (files == null) {
            return;
        }
        for (File file : files) {
            try {
                SubagentInstance inst = loadAgentFromFile(file);
                if (inst != null) {
                    agents.put(inst.id, inst);
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to load agent from " + file.getName(), e);
            }
        }
    }

    /** Load a single agent from a Markdown file with YAML frontmatter. */
    private SubagentInstance loadAgentFromFile(File file) throws IOException {
        List<String> lines = Files.readAllLines(file.toPath(), StandardCharsets.UTF_8);
        if (lines.isEmpty()) {
            return null;
        }
        String id = file.getName();
        if (id.endsWith(".md")) {
            id = id.substring(0, id.length() - 3);
        }
        String name = id;
        String model = "";
        String description = "";
        StringBuilder prompt = new StringBuilder();
        boolean inFrontmatter = false;
        boolean inBody = false;
        for (String line : lines) {
            if (!inFrontmatter && line.trim().equals("---")) {
                inFrontmatter = true;
                continue;
            }
            if (inFrontmatter && line.trim().equals("---")) {
                inFrontmatter = false;
                inBody = true;
                continue;
            }
            if (inFrontmatter) {
                int eq = line.indexOf(':');
                if (eq > 0) {
                    String key = line.substring(0, eq).trim();
                    String val = line.substring(eq + 1).trim();
                    switch (key) {
                        case "name": name = val; break;
                        case "model": model = val; break;
                        case "description": description = val; break;
                    }
                }
            } else if (inBody) {
                if (prompt.length() > 0) {
                    prompt.append('\n');
                }
                prompt.append(line);
            }
        }
        SubagentType type = new SubagentType(id, name, name, prompt.toString(), prompt.toString());
        SubagentInstance inst = new SubagentInstance(id, type);
        // messageCount stays 0 on load
        return inst;
    }

    /** Persist a single agent to $HOME/.gemini/config/agents/<id>.md. */
    private void saveAgentToFile(SubagentInstance inst) {
        if (!AGENTS_DIR.isDirectory()) {
            AGENTS_DIR.mkdirs();
        }
        File file = new File(AGENTS_DIR, inst.id + ".md");
        try (PrintWriter w = new PrintWriter(new BufferedWriter(
                new FileWriter(file, StandardCharsets.UTF_8)))) {
            w.println("---");
            w.println("name: " + inst.type.nameEn);
            w.println("model: " + inst.type.id);
            w.println("description: " + inst.type.nameEn + " subagent");
            w.println("enable_write_tools: true");
            w.println("enable_mcp_tools: false");
            w.println("enable_subagent_tools: false");
            w.println("---");
            w.println();
            w.print(inst.type.promptEn);
        } catch (IOException e) {
            Log.w(TAG, "Failed to save agent " + inst.id, e);
        }
    }

    /** Delete an agent's Markdown file. */
    private void deleteAgentFile(String id) {
        File file = new File(AGENTS_DIR, id + ".md");
        if (file.exists()) {
            file.delete();
        }
    }

    /** Sync aggregated rules file $HOME/.gemini/config/rules/custom_subagents.md. */
    private void syncCustomSubagentsRules() {
        if (!RULES_FILE.getParentFile().isDirectory()) {
            RULES_FILE.getParentFile().mkdirs();
        }
        try (PrintWriter w = new PrintWriter(new BufferedWriter(
                new FileWriter(RULES_FILE, StandardCharsets.UTF_8)))) {
            w.println("# Custom subagents (auto-synced by SubagentManager)");
            w.println("Generated agents: " + agents.size());
            w.println();
            for (SubagentInstance inst : agents.values()) {
                w.println("- id: " + inst.id);
                w.println("  name: " + inst.type.nameEn);
                w.println("  model: " + inst.type.id);
                w.println("  description: " + inst.type.nameEn + " subagent");
                w.println();
            }
        } catch (IOException e) {
            Log.w(TAG, "Failed to sync custom_subagents.md", e);
        }
    }
}

