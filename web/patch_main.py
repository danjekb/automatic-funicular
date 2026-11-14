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
        'var u=window.__APP_CONFIG__?.modelManagerUrl||(window.location.protocol+"//"+window.location.hostname+":50998/_addon/");'
        'window.open(u,"_blank");'
        '}},"Open Dashboard")}))),'
    )
    if models_target in content and "Antigravity Model Manager" not in content:
        content = content.replace(models_target, models_repl, 1)
        modified = True
        print("[web-patch] Injected Model Manager dashboard button into Models screen")

    if modified:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)

    return True

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "main.js")
    if not patch_main(path):
        sys.exit(1)
