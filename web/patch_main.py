#!/usr/bin/env python3
"""
web/patch_main.py - Dynamic patcher for web/main.js.

Locates the Appearance settings block and injects the Desktop Mode toggle
if not already present. Safe, idempotent, and resilient to upstream changes.
"""

import sys
import os
import re

def patch_main(file_path):
    if not os.path.isfile(file_path):
        print(f"[web-patch] file not found: {file_path}", file=sys.stderr)
        return False

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    modified = False

    if "Desktop Mode" not in content and "ag_desktop_mode" not in content:
        # 1. State hook injection pattern in Appearance component:
        hook_pattern = re.compile(r'(var\s+[A-Za-z0-9_$]+=[A-Za-z0-9_$]+!==3,\s*[A-Za-z0-9_$]+=[A-Za-z0-9_$]+!==2,\s*[A-Za-z0-9_$]+=[A-Za-z0-9_$]+=>\s*[A-Za-z0-9_$]+=>\{.*?\};)')
        hook_match = hook_pattern.search(content)

        # 2. JSX Theme element injection: find Theme element in Appearance
        theme_idx = content.find('{label:"Theme"')
        theme_match = None
        react_id = "A"
        if theme_idx != -1:
            window_start = max(0, theme_idx - 100)
            window_end = min(len(content), theme_idx + 500)
            window_text = content[window_start:window_end]
            theme_pattern = re.compile(
                r'([A-Za-z0-9_$]+)\.createElement\(([A-Za-z0-9_$]+),\{label:"Theme",.*?onSelect:[A-Za-z0-9_$]+\}\)'
            )
            theme_match = theme_pattern.search(window_text)
            if theme_match:
                react_id = theme_match.group(1)

        if hook_match and theme_match:
            orig_hook = hook_match.group(1)
            injected_hook = (
                f"var [isDesktop,setIsDesktop]=(0,{react_id}.useState)(()=>{{"
                "try{if(window.Android&&typeof window.Android.isDesktopMode==='function')return window.Android.isDesktopMode();"
                "var s=localStorage.getItem('ag_desktop_mode');return s===null?!1:s==='true'}catch(_){return !1}});"
                f"var onDesktopToggle=(0,{react_id}.useCallback)(v=>{{"
                "setIsDesktop(v);try{localStorage.setItem('ag_desktop_mode',String(v));"
                "if(window.Android&&typeof window.Android.setDesktopMode==='function')window.Android.setDesktopMode(v)}catch(_){}},[]);"
                + orig_hook
            )

            item_comp = "v3"
            switch_comp = "dX"
            re_idx = content.find('rightElement:')
            if re_idx != -1:
                re_window = content[max(0, re_idx - 150):min(len(content), re_idx + 150)]
                item_m = re.search(r'([A-Za-z0-9_$]+)\.createElement\(([A-Za-z0-9_$]+),\{label:[^,]+,description:[^,]+,rightElement:', re_window)
                if item_m:
                    item_comp = item_m.group(2)
                sw_m = re.search(r'rightElement:[A-Za-z0-9_$]+\.createElement\(([A-Za-z0-9_$]+),\{checked:', re_window)
                if sw_m:
                    switch_comp = sw_m.group(1)

            orig_theme = theme_match.group(0)
            injected_theme = (
                orig_theme
                + f',{react_id}.createElement({item_comp},{{label:"Desktop Mode",description:"Use desktop viewport and user agent for the workspace",'
                + f'rightElement:{react_id}.createElement({switch_comp},{{checked:isDesktop,onCheckedChange:onDesktopToggle}})}})'
            )

            content = content.replace(orig_hook, injected_hook, 1)
            content = content.replace(orig_theme, injected_theme, 1)
            modified = True
            print("[web-patch] Successfully patched Desktop Mode toggle into main.js")

    # 3. Export window.__agySettings in QC.Provider for Security Shield
    if "__agySettings" not in content:
        qc_orig = 'A.createElement(QC.Provider,{value:l},'
        qc_patched = 'A.createElement(QC.Provider,{value:(window.__agySettings={store:l,I:I,Ui:Ui,gEa:gEa,iEa:iEa,hEa:hEa,qq:qq,Mt:Mt},l)},'
        if qc_orig in content:
            content = content.replace(qc_orig, qc_patched, 1)
            modified = True
            print("[web-patch] Successfully patched __agySettings export into QC.Provider")
        else:
            print("[web-patch] QC.Provider target not found for __agySettings", file=sys.stderr)

    # 4. Background Resume Trajectory Stream Sync (vKa)
    vka_target = 'this._factory=a}'
    vka_repl = (
        'this._factory=a;'
        'this.refreshTrajectories=()=>{try{if(!this._factory)return;'
        'for(let [c,e]of this.JSC$7869__states.entries()){let f=e;f.link.dispose();f.underlyingProvider.dispose();f.underlyingProvider=this._factory(c);f.link=Hja(f.underlyingProvider,f.provider,{omitInitial:!0});}'
        '}catch(err){console.warn("[AGY ResumeSync] refreshTrajectories err",err)}};'
        'window.__agTrajectoriesRegistry=this;'
        'window.__agRefreshTrajectories=s=>{console.log("[AGY ResumeSync] Refreshing active trajectories triggered by",s);this.refreshTrajectories()}}'
    )
    if vka_target in content and "agTrajectoriesRegistry" not in content:
        content = content.replace(vka_target, vka_repl, 1)
        modified = True
        print("[web-patch] Exposed window.__agTrajectoriesRegistry & __agRefreshTrajectories in vKa")

    vka_disp_target = 'dispose(){for(let [a]of this.JSC$7869__states.entries())this._disposeEntry(a)}'
    vka_disp_repl = 'dispose(){if(window.__agTrajectoriesRegistry===this){window.__agTrajectoriesRegistry=void 0;window.__agRefreshTrajectories=void 0}for(let [a]of this.JSC$7869__states.entries())this._disposeEntry(a)}'
    if vka_disp_target in content:
        content = content.replace(vka_disp_target, vka_disp_repl, 1)
        modified = True
        print("[web-patch] Cleaned up global registry on vKa dispose")

    # 5. Unlock Developer Settings ("Developer-only tools" / Feature Environment Override)
    dev_target = 'developerMode:{feature:{enabled:!1,runtimeEnvironmentOverride:!1,featureFlagOverrides:!1,workspaceUriSwitcher:!1}'
    dev_repl = 'developerMode:{feature:{enabled:!0,runtimeEnvironmentOverride:!0,featureFlagOverrides:!0,workspaceUriSwitcher:!0}'
    if dev_target in content:
        content = content.replace(dev_target, dev_repl, 1)
        modified = True
        print("[web-patch] Unlocked developerMode (Feature Environment Override & Custom Flags)")

    # 6. Unlock Labs & Experimental Capabilities
    # 6a. Labs section in General Settings
    labs_target = 'labs:{feature:!1,applyFirst:[{runtimeGating:{binary:["hub"],userCohort:["google"]},feature:!0}]}'
    labs_repl = 'labs:{feature:!0}'
    if labs_target in content:
        content = content.replace(labs_target, labs_repl, 1)
        modified = True
        print("[web-patch] Unlocked Labs experimental settings section")

    # 6b. Autonomous Mode
    auto_target = 'autonomousMode:{feature:!1,\napplyAll:[{runtimeGating:{binary:["hub"],userCohort:["google"],customFlag:Zz.autonomousMode.customFlag},feature:!0}]}'
    auto_repl = 'autonomousMode:{feature:!0}'
    if auto_target in content:
        content = content.replace(auto_target, auto_repl, 1)
        modified = True
        print("[web-patch] Unlocked Autonomous Mode")

    # 6c. Inline Actions
    inline_target = 'inlineActions:{feature:!1,applyAll:[{runtimeGating:{binary:["hub"],userCohort:["google"],customFlag:Zz.inlineActions.customFlag},feature:!0}]}'
    inline_repl = 'inlineActions:{feature:!0}'
    if inline_target in content:
        content = content.replace(inline_target, inline_repl, 1)
        modified = True
        print("[web-patch] Unlocked Inline Actions")

    # 6d. Concierge Agent (Chief of Staff) visibility in Labs
    concierge_vis = 'visibilityCustomFlag:"enable-concierge-agent"'
    if concierge_vis in content:
        content = content.replace(concierge_vis, 'visibilityCustomFlag:void 0', 1)
        modified = True
        print("[web-patch] Unlocked Chief of Staff (Concierge Agent) in Labs")

    # 6e. File Explorer Tab in Workspace Sidebar
    file_exp_target = 'fileExplorerTab:{feature:{isEnabled:!1},applyFirst:[{runtimeGating:{host:[Qi.Extension]},feature:{isEnabled:!1}}],applyAll:[{runtimeGating:{customFlag:"enable-file-explorer-tab"},feature:{isEnabled:!0}}]}'
    file_exp_repl = 'fileExplorerTab:{feature:{isEnabled:!0}}'
    if file_exp_target in content:
        content = content.replace(file_exp_target, file_exp_repl, 1)
        modified = True
        print("[web-patch] Unlocked File Explorer tab")

    # 6f. Built-in PDF Viewer
    pdf_target = 'pdfViewer:{feature:!1,applyAll:[{runtimeGating:{customFlag:"enable-pdf-viewer"},feature:!0}]}'
    pdf_repl = 'pdfViewer:{feature:!0}'
    if pdf_target in content:
        content = content.replace(pdf_target, pdf_repl, 1)
        modified = True
        print("[web-patch] Unlocked PDF Viewer")

    # 6g. Split View
    split_target = 'splitView:{feature:{enabled:!1},applyAll:[{runtimeGating:{customFlag:"enable-split-view"},feature:{enabled:!0}},{runtimeGating:{isDevMode:!0},feature:{enabled:!0}},{runtimeGating:{host:[Qi.Web.Mobile]},feature:{enabled:!1}}]}'
    split_repl = 'splitView:{feature:{enabled:!0}}'
    if split_target in content:
        content = content.replace(split_target, split_repl, 1)
        modified = True
        print("[web-patch] Unlocked Split View")

    # 6h. Conversation Forking & Historical Step Fork
    fork_target = '...(L9()?["enable-conversation-forking"]:[]),'
    fork_repl = '...["enable-conversation-forking","enable-fork-at-historical-step"],'
    if fork_target in content:
        content = content.replace(fork_target, fork_repl, 1)
        modified = True
        print("[web-patch] Unlocked Conversation Forking")

    # 7. Inject Custom Models Manager dashboard button in Models screen (FLb)
    models_target = 'description:"Manage your model quota and credits."},'
    models_repl = (
        'description:"Manage your model quota and credits."},'
        'A.createElement(w3,{title:"Custom Models",subtitle:"Configure external and local model providers (Ollama, DeepSeek, OpenAI, Claude)."},'
        'A.createElement(u3,null,A.createElement(v3,{label:"Antigravity Model Manager",description:"Open the local web panel to add, discover, and manage AI models.",'
        'rightElement:A.createElement(tA,{variant:"primary",size:"sm",onClick:function(){'
        'if(window.Android&&typeof window.Android.openModelManager==="function"){window.Android.openModelManager();return;}'
        'var u=(window.Android&&typeof window.Android.getModelManagerUrl==="function"&&window.Android.getModelManagerUrl())||window.__APP_CONFIG__?.modelManagerUrl||"http://127.0.0.1:50996/_addon/";'
        'window.open(u,"_blank");'
        '}},"Open Dashboard")}))),'
        'A.createElement(w3,{title:"Subagents",subtitle:"Autonomous specialized agents running in isolated background contexts."},'
        'A.createElement("div",{key:"subagents-container",ref:function(x){if(x&&window.__agySubagentsMount){window.__agySubagentsMount(x);}}})),'
    )
    if models_target in content and "Antigravity Model Manager" not in content:
        content = content.replace(models_target, models_repl, 1)
        modified = True
        print("[web-patch] Injected Model Manager & Subagents panel into Models screen")

    # 8a. Add "AMOLED Black" theme preset to Jrc.dark
    jrc_target = 'dark:{"Default Dark":{background:"#101010",foregroundOverride:"#cccccc",\nprimary:"#007acc"},'
    jrc_repl = 'dark:{"Default Dark":{background:"#101010",foregroundOverride:"#cccccc",\nprimary:"#007acc"},"AMOLED Black":{background:"#000000",foregroundOverride:"#ffffff",primary:"#007acc"},'
    if jrc_target in content and '"AMOLED Black":{' not in content:
        content = content.replace(jrc_target, jrc_repl, 1)
        modified = True
        print("[web-patch] Added AMOLED Black to theme presets (Jrc.dark)")

    # 8b. Add "AMOLED Black" syntax highlighting preset to Drc.dark
    drc_target = 'dark:{"Default Dark":{comment:"#8292a2",punctuation:"#f8f8f2",property:"#f92672",deleted:"#f92672",inserted:"#a6e22e",tag:"#f92672",constant:"#f92672",number:"#ae81ff",string:"#a6e22e",attrName:"#a6e22e",builtin:"#a6e22e",operator:"#f8f8f2",variable:"#f8f8f2",attrValue:"#e6db74",keyword:"#66d9ef",function:"#e6db74",\nclassName:"#e6db74",regex:"#fd971f"},'
    drc_repl = drc_target + '"AMOLED Black":{comment:"#8292a2",punctuation:"#f8f8f2",property:"#f92672",deleted:"#f92672",inserted:"#a6e22e",tag:"#f92672",constant:"#f92672",number:"#ae81ff",string:"#a6e22e",attrName:"#a6e22e",builtin:"#a6e22e",operator:"#f8f8f2",variable:"#f8f8f2",attrValue:"#e6db74",keyword:"#66d9ef",function:"#e6db74",className:"#e6db74",regex:"#fd971f"},'
    if drc_target in content and '"AMOLED Black":{comment:' not in content:
        content = content.replace(drc_target, drc_repl, 1)
        modified = True
        print("[web-patch] Added AMOLED Black to syntax presets (Drc.dark)")

    # 8c. Unclamp #050505 to #000000 and sync AMOLED state with Android & DOM
    clamp_target = 'b=b?"#050505":h;'
    clamp_repl = (
        'b=b?"#000000":h;{let _amoled=(h==="#000000");'
        'document.documentElement.classList.toggle("amoled-black",_amoled);'
        'document.body&&document.body.classList.toggle("amoled-black",_amoled);'
        'try{localStorage.setItem("jetski.amoled",_amoled?"true":"false");}catch(E){}'
        'if(window.Android&&typeof window.Android.onVisualThemeChanged==="function"){'
        'window.Android.onVisualThemeChanged(_amoled?"amoled":(a?"dark":"light"));}}'
    )
    if clamp_target in content:
        content = content.replace(clamp_target, clamp_repl, 1)
        modified = True
        print("[web-patch] Unclamped black to #000000 and wired AMOLED visual theme sync")

    # 9. Item 1: Arbitrary file attachments & 10 MB text limit (ported from Leostryx)
    #    Idempotent: skips if already patched ("agyMimeForName" present).
    if "agyMimeForName" not in content:
        EXT_MIME = {
            "py": "text/x-python", "pyw": "text/x-python", "js": "text/javascript",
            "mjs": "text/javascript", "cjs": "text/javascript", "jsx": "text/javascript",
            "ts": "text/x-typescript", "tsx": "text/x-typescript", "json": "application/json",
            "jsonl": "application/json", "ipynb": "application/json", "md": "text/markdown",
            "markdown": "text/markdown", "mdx": "text/markdown", "rst": "text/plain",
            "txt": "text/plain", "log": "text/plain", "csv": "text/csv", "tsv": "text/csv",
            "html": "text/html", "htm": "text/html", "xhtml": "text/html", "css": "text/css",
            "scss": "text/css", "sass": "text/css", "less": "text/css", "xml": "text/xml",
            "xsl": "text/xml", "svg": "image/svg+xml", "yaml": "application/yaml",
            "yml": "application/yaml", "toml": "application/toml", "ini": "text/plain",
            "cfg": "text/plain", "conf": "text/plain", "properties": "text/plain",
            "env": "text/plain", "sh": "application/x-sh", "bash": "application/x-sh",
            "zsh": "application/x-sh", "fish": "application/x-sh", "bat": "text/plain",
            "cmd": "text/plain", "ps1": "text/plain", "c": "text/x-c", "h": "text/x-c",
            "cc": "text/x-c++", "cpp": "text/x-c++", "cxx": "text/x-c++", "hpp": "text/x-c++",
            "cs": "text/plain", "java": "text/x-java", "kt": "text/plain", "kts": "text/plain",
            "scala": "text/plain", "swift": "text/plain", "go": "text/x-go", "rs": "text/x-rust",
            "rb": "text/x-ruby", "php": "text/x-php", "pl": "text/x-perl", "lua": "text/x-lua",
            "r": "text/plain", "m": "text/plain", "mm": "text/plain", "dart": "text/plain",
            "gradle": "text/plain", "groovy": "text/plain", "sql": "application/sql",
            "proto": "text/plain", "graphql": "text/plain", "gql": "text/plain",
            "diff": "text/plain", "patch": "text/plain", "srt": "text/plain",
            "vtt": "text/vtt", "ass": "text/plain", "tex": "text/x-tex", "bib": "text/plain",
            "makefile": "text/plain", "mk": "text/plain", "dockerfile": "text/plain",
            "gitignore": "text/plain",
            "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
            "webp": "image/webp", "bmp": "image/bmp", "ico": "image/x-icon",
            "avif": "image/avif", "heic": "image/heic",
            "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
            "avi": "video/x-msvideo", "mkv": "video/x-matroska",
            "mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4", "aac": "audio/aac",
            "ogg": "audio/ogg", "flac": "audio/flac", "opus": "audio/opus", "weba": "audio/webm",
            "pdf": "application/pdf", "zip": "application/zip",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "doc": "application/msword", "xls": "application/vnd.ms-excel",
            "ppt": "application/vnd.ms-powerpoint",
            "gz": "application/gzip", "tgz": "application/gzip", "tar": "application/x-tar",
            "7z": "application/x-7z-compressed", "rar": "application/vnd.rar",
            "apk": "application/vnd.android.package-archive",
            "ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2",
        }
        import json as _json

        mime_map_js = (
            'function agyMimeForName(a){'
            'a=(a||"").slice((a||"").lastIndexOf(".")+1).toLowerCase();'
            'return ' + _json.dumps(EXT_MIME, ensure_ascii=True) + '[a]||""}'
        )

        generic_attach = (
            'else if(m.size===0)e?.("File is empty"),'
            'g("validation_check_failed",Error("File is empty"));'
            'else if(m.size>20971520)e?.("File size exceeds 20MB limit"),'
            'g("validation_check_failed",Error("File size exceeds 20MB limit"));'
            'else try{'
            'let x=m.type&&m.type!=="application/octet-stream"?m.type:agyMimeForName(m.name)||"",'
            'y=new Uint8Array(q(await n(m.arrayBuffer())));'
            'if(!x||x==="application/octet-stream"){'
            'let z=Math.min(y.length,65536),t=0,i=0;'
            'for(;i<z;i++){let c=y[i];if(c===0||c===127){t=1;break}if(c<7||c>13&&c<32)t++}'
            'x=!t||t/Math.max(z,1)<0.02?"text/plain":"application/octet-stream"'
            '}'
            'let B=p(I.MediaSchema,{mimeType:x,description:m.name,payload:{case:"inlineData",value:y}});'
            'BB(m)&&AB.set(B,m);'
            'a([B])'
            '}catch(x){q(),g("validation_check_failed",x)}'
        )

        drop_old = (
            'Array.from(v.dataTransfer?.items||[]).some(w=>w.kind==="file"&&'
            '(CB("",w.type)||w.type.startsWith("image/")||w.type.startsWith("video/")||'
            'w.type.startsWith("audio/")||w.type==="application/pdf"||xNa(w.type)||pNa.includes(w.type)))'
        )
        drop_new = 'Array.from(v.dataTransfer?.items||[]).some(w=>w.kind==="file")'

        filter_old = '!y.has(C.name)&&CB(C.name,C.type)&&B.items.add(C)'
        filter_new = '!y.has(C.name)&&B.items.add(C)'

        text_re = re.compile(
            r'if\(u\)if\(m\.size>1048576\)e\?\.\("Text file size exceeds 1MB limit"\),'
            r'\s*g\("validation_check_failed",\s*Error\("Text file size exceeds 1MB limit"\)\);'
        )
        text_new = (
            'if(u)if(m.size>10485760)e?.("Text file size exceeds 10MB limit"),'
            'g("validation_check_failed",Error("Text file size exceeds 10MB limit"));'
        )

        guard_mark = "__agyBlockUnsupportedMedia"
        guard_toast_old = (
            'if(LNa(a,b.supportedMimeTypes))'
            'return"Selected model does not support this media type"'
        )
        guard_toast_new = (
            'if(window.__agyBlockUnsupportedMedia===!0&&LNa(a,b.supportedMimeTypes))'
            'return"Selected model does not support this media type"'
        )
        guard_send_old = 'if(LNa(l,r.supportedMimeTypes))throw Error("Your model does not support this media. Please select a different model to send this message, or remove the media.");'
        guard_send_new = 'if(window.__agyBlockUnsupportedMedia===!0&&LNa(l,r.supportedMimeTypes))throw Error("Your model does not support this media. Please select a different model to send this message, or remove the media.");'

        upstream_mark = 'var u5a=(a,b,c,e,f=5)=>{'

        def _sub_once(src, old, new, label):
            n = src.count(old)
            assert n == 1, f"[web-patch] {label}: expected 1 occurrence, got {n}"
            print(f"  [web-patch] [ok] {label}")
            return src.replace(old, new, 1)

        content = _sub_once(content, upstream_mark, mime_map_js + "\n" + upstream_mark, "A mime resolver")
        content = _sub_once(content, drop_old, drop_new, "B dragover filter")
        content = _sub_once(content, filter_old, filter_new, "B drop filter")

        assert content.count('else e?.("Unsupported file format")') == 1, \
            "[web-patch] C: 'Unsupported file format' expected exactly 1 occurrence"
        content = _sub_once(content, 'else e?.("Unsupported file format")', generic_attach, "C generic attach")

        text_cap_old = 'if(u)if(m.size>1048576)e?.("Text file size exceeds 1MB limit"),'
        text_cap_new = 'if(u)if(m.size>10485760)e?.("Text file size exceeds 10MB limit"),'
        n_text_cap = content.count(text_cap_old)
        assert n_text_cap >= 1, "[web-patch] D: text cap pattern not found"
        content = content.replace(text_cap_old, text_cap_new)
        print(f"  [web-patch] [ok] D text cap 1MB->10MB ({n_text_cap} occurrences replaced)")
        assert "Unsupported file format" not in content

        if guard_mark not in content:
            content = _sub_once(content, guard_toast_old, guard_toast_new, "E attach-time guard")
            content = _sub_once(content, guard_send_old, guard_send_new, "E send-time guard")

        modified = True
        print("[web-patch] Item 1: arbitrary file attachments & 10 MB text limit applied")
    else:
        print("[web-patch] Item 1: already patched (agyMimeForName present), skipping.")

    if modified:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)

    return True

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "main.js")
    if not patch_main(path):
        sys.exit(1)
