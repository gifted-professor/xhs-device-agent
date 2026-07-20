import requests, json, time, os, subprocess, sys, re

# 适配 03 号机（微信新版本）钱包余额读取
# 目标：识别微信「服务」页钱包入口下方的金额，或钱包页「钱包余额」
# 不依赖 wechat.wallet-balance 专有命令，只使用效卫 API 通用能力 + 本地 Windows OCR

BASE_URL = "http://127.0.0.1:17891/v1/command"
MACHINE = "03"
WECHAT_PACKAGE = "com.tencent.mm"
PS_OCR = r"C:\Users\windows 10\Desktop\coding\control_Test\xhs-device-agent\scripts\windows-ocr.ps1"


def cmd(body, timeout=120):
    r = requests.post(BASE_URL, json=body, timeout=timeout)
    try:
        return r.json()
    except Exception:
        return {"ok": False, "_raw": r.text}


def tap_ocr(text, expect_text, reason, rollback):
    body = {
        "command": "device.tap-ocr",
        "machine": MACHINE,
        "package": WECHAT_PACKAGE,
        "text": text,
        "expectText": expect_text,
        "reason": reason,
        "rollback": rollback,
    }
    return cmd(body, timeout=120)


def ensure_wechat_open():
    """确保微信在前台。如果已经在微信界面，不重复操作。"""
    print("Step 1: 检查当前是否已在微信")
    screenshot_path = save_screenshot_to_local()
    text = ocr_page_text(screenshot_path)
    text_no_space = text.replace(" ", "")
    if "微信" in text_no_space or "WeChat" in text_no_space:
        print("   当前已在微信界面，跳过 open")
        return

    print("   当前不在微信，尝试 home + open")
    res = cmd({"command": "device.home", "machine": MACHINE})
    if not res.get("ok"):
        raise RuntimeError(f"device.home failed: {res}")
    time.sleep(2)
    res = cmd({"command": "app.open", "machine": MACHINE, "package": WECHAT_PACKAGE})
    if not res.get("ok"):
        raise RuntimeError(f"app.open failed: {res}")
    print("   等待 10 秒...")
    time.sleep(10)

    screenshot_path = save_screenshot_to_local()
    text = ocr_page_text(screenshot_path)
    text_no_space = text.replace(" ", "")
    if "微信" not in text_no_space and "WeChat" not in text_no_space:
        raise RuntimeError(f"微信仍未进入前台，OCR 文本: {text[:200]}")


def ensure_wechat_service_page():
    """确保在微信服务页（钱包余额所在页）。03 号机新版微信：服务页显示 钱包 ¥2559.68"""
    print("\nStep 2: 检查是否已在服务页")
    screenshot_path = save_screenshot_to_local()
    text = ocr_page_text(screenshot_path)
    if "钱包" in text and "¥" in text:
        print("   已在服务页钱包余额界面")
        return

    if "我" in text:
        print("   在个人页，点击'服务'")
        res = tap_ocr("服务", "钱包", "进入服务页", "返回个人页")
        if not res.get("ok"):
            raise RuntimeError(f"点服务失败: {res}")
        time.sleep(2)
        return

    # 兜底：从首页走一遍
    print("   从首页导航到 我 -> 服务")
    res = tap_ocr("我", "服务", "进入个人页", "返回首页")
    if not res.get("ok"):
        # 可能已经更深，忽略
        pass
    else:
        time.sleep(2)
    res = tap_ocr("服务", "钱包", "进入服务页", "返回个人页")
    if not res.get("ok"):
        raise RuntimeError(f"点服务失败: {res}")
    time.sleep(2)

def save_screenshot_to_local():
    """通过 device.screen 保存截图到本地，然后扫描运行目录获取真实路径。"""
    res = cmd({"command": "device.screen", "machine": MACHINE}, timeout=60)
    if not res.get("ok"):
        raise RuntimeError(f"device.screen failed: {res}")
    # gateway 返回的截图路径被脱敏，从运行目录里找最新生成的 screen.png
    time.sleep(1)
    return find_latest_screenshot()


def find_latest_screenshot():
    """在 data/matrix/runs 下找到最新的 screen.png。"""
    root = r"C:\Users\windows 10\Desktop\coding\control_Test\xhs-device-agent\data\matrix\runs"
    candidates = []
    for d in os.listdir(root):
        run_dir = os.path.join(root, d)
        if not os.path.isdir(run_dir):
            continue
        for subroot, dirs, files in os.walk(run_dir):
            for f in files:
                if f.endswith(".png") and "screen" in f.lower():
                    fp = os.path.join(subroot, f)
                    candidates.append((fp, os.path.getmtime(fp)))
    if not candidates:
        raise RuntimeError("找不到本地截图文件")
    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates[0][0]


def ocr_page_text(image_path):
    """返回页面所有 OCR 文字。"""
    if not os.path.exists(image_path):
        raise RuntimeError(f"截图不存在: {image_path}")
    proc = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", PS_OCR, "-ImagePath", image_path, "-Mode", "page_safety"],
        capture_output=True, text=True, timeout=60, encoding="utf-8"
    )
    if proc.returncode != 0:
        raise RuntimeError(f"OCR 失败: {proc.stderr}")
    result = json.loads(proc.stdout)
    return result.get("text", "")


def extract_wallet_amount(text):
    """从 OCR 文本中提取钱包余额。例如：'钱包 ¥ 2559 . 68' -> 2559.68"""
    # 尝试找 "钱包" 后面的金额
    # 模式：¥ 2559 . 68 或 ¥2559.68
    # 先清理空格
    cleaned = re.sub(r"\s+", "", text)
    match = re.search(r"钱包[¥￥]?(\d+[.,]\d{2})", cleaned)
    if match:
        return match.group(1).replace(",", ".")
    # 兜底：任何 ¥ 2559.68
    match = re.search(r"[¥￥](\d+[.,]\d{2})", cleaned)
    if match:
        return match.group(1).replace(",", ".")
    return None


def main():
    try:
        ensure_wechat_open()
        ensure_wechat_service_page()

        print("\nStep 3: 截图并 OCR 读取钱包余额")
        screenshot_path = save_screenshot_to_local()
        text = ocr_page_text(screenshot_path)
        amount = extract_wallet_amount(text)

        print("\n=== 结果 ===")
        result = {
            "machine": MACHINE,
            "currency": "CNY",
            "balance": amount,
            "raw_ocr_text": text[:500],
            "screenshot": screenshot_path,
            "transport": "xiaowei-api + local-windows-ocr",
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if amount is None:
            print("\n警告：未能提取到金额，请检查 OCR 文本。")
    except Exception as e:
        print(f"\n=== 失败 ===\n{str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
