import requests, json, time, os, subprocess, re

# 极简版：03 号机微信服务页钱包余额读取
# 前提：用户已手动把 03 号机停到微信服务页（显示“钱包 ¥xxxx.xx”）
# 不依赖 wechat.wallet-balance 专有命令，只使用 device.screen + 本地 Windows OCR

BASE_URL = "http://127.0.0.1:17891/v1/command"
MACHINE = "03"
PS_OCR = r"C:\Users\windows 10\Desktop\coding\control_Test\xhs-device-agent\scripts\windows-ocr.ps1"


def cmd(body, timeout=60):
    r = requests.post(BASE_URL, json=body, timeout=timeout)
    try:
        return r.json()
    except Exception:
        return {"ok": False, "_raw": r.text}


def latest_screenshot():
    root = r"C:\Users\windows 10\Desktop\coding\control_Test\xhs-device-agent\data\matrix\runs"
    candidates = []
    for d in os.listdir(root):
        run_dir = os.path.join(root, d)
        if not os.path.isdir(run_dir):
            continue
        for subroot, dirs, files in os.walk(run_dir):
            for f in files:
                if f.endswith(".png"):
                    candidates.append((os.path.join(subroot, f), os.path.getmtime(os.path.join(subroot, f))))
    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates[0][0] if candidates else None


def ocr_image(image_path):
    proc = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", PS_OCR, "-ImagePath", image_path, "-Mode", "page_safety"],
        capture_output=True, text=True, timeout=60, encoding="utf-8"
    )
    if proc.returncode != 0:
        raise RuntimeError(f"OCR 失败: {proc.stderr}")
    return json.loads(proc.stdout).get("text", "")


def extract_wallet_amount(text):
    # 清理 Windows OCR 插入的空格
    cleaned = text.replace(" ", "")
    # 优先匹配“钱包”后的金额
    match = re.search(r"钱包[¥￥]?(\d+[.,]\d{2})", cleaned)
    if match:
        return match.group(1).replace(",", ".")
    # 兜底：任何 ¥ xxx.xx
    match = re.search(r"[¥￥](\d+[.,]\d{2})", cleaned)
    if match:
        return match.group(1).replace(",", ".")
    return None


def main():
    print(f"=== 03 号机微信服务页钱包余额读取 ===\n")

    print("Step 1: 截图")
    res = cmd({"command": "device.screen", "machine": MACHINE}, timeout=60)
    if not res.get("ok"):
        raise RuntimeError(f"device.screen failed: {res}")
    time.sleep(1)

    screenshot_path = latest_screenshot()
    if not screenshot_path:
        raise RuntimeError("找不到截图文件")
    print(f"   截图: {screenshot_path}")

    print("\nStep 2: OCR 识别")
    text = ocr_image(screenshot_path)
    print(f"   OCR 文本: {text[:400]}")

    print("\nStep 3: 提取余额")
    amount = extract_wallet_amount(text)
    if amount is None:
        raise RuntimeError(f"未能提取到余额，OCR 文本: {text}")

    result = {
        "machine": MACHINE,
        "currency": "CNY",
        "balance": amount,
        "raw_ocr_text": text[:500],
        "screenshot": screenshot_path,
        "transport": "xiaowei-api + local-windows-ocr",
    }
    print("\n=== 结果 ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
