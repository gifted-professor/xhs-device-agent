import requests, json, time, os, subprocess, sys

# 适配 03 号机（微信新版本）余额读取
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

def wait_for_wechat_foreground():
    for attempt in range(3):
        res = cmd({"command": "device.ui", "machine": MACHINE}, timeout=30)
        stdout = res.get("stdout", "")
        if "com.tencent.mm" in stdout:
            return True
        time.sleep(2)
    return False

def navigate_to_change_page():
    print("Step 1: 回到首页")
    res = cmd({"command": "device.home", "machine": MACHINE})
    if not res.get("ok"):
        raise RuntimeError(f"device.home failed: {res}")
    time.sleep(2)

    print("Step 2: 打开微信")
    res = cmd({"command": "app.open", "machine": MACHINE, "package": WECHAT_PACKAGE})
    if not res.get("ok"):
        raise RuntimeError(f"app.open failed: {res}")
    print("   等待 15 秒...")
    time.sleep(15)

    if not wait_for_wechat_foreground():
        print("   微信未进入前台，尝试重新 home + open")
        cmd({"command": "device.home", "machine": MACHINE})
        time.sleep(2)
        cmd({"command": "app.open", "machine": MACHINE, "package": WECHAT_PACKAGE})
        time.sleep(15)
        if not wait_for_wechat_foreground():
            raise RuntimeError("微信未进入前台")

    print("Step 3: 点 '我' -> 验证 '服务'")
    res = tap_ocr("我", "服务", "进入个人页", "返回首页")
    if not res.get("ok"):
        # 03 号机当前可能已经在服务页，重试一次
        print("   第一次点 '我' 失败，可能已经在服务页，直接继续")
    else:
        time.sleep(2)

    print("Step 4: 点 '服务' -> 验证 '钱包'")
    res = tap_ocr("服务", "钱包", "进入服务页", "返回个人页")
    if not res.get("ok"):
        raise RuntimeError(f"点服务失败: {json.dumps(res, ensure_ascii=False)[:500]}")
    time.sleep(2)

    print("Step 5: 点 '钱包' -> 验证 '零钱'")
    res = tap_ocr("钱包", "零钱", "进入钱包页", "返回服务页")
    if not res.get("ok"):
        raise RuntimeError(f"点钱包失败: {json.dumps(res, ensure_ascii=False)[:500]}")
    time.sleep(2)

    print("Step 6: 点 '零钱' -> 验证 '充值'")
    res = tap_ocr("零钱", "充值", "进入零钱详情页", "返回钱包页")
    if not res.get("ok"):
        # 兼容：有些版本点零钱后验证 '提现' 而不是 '充值'
        res = tap_ocr("零钱", "提现", "进入零钱详情页", "返回钱包页")
        if not res.get("ok"):
            raise RuntimeError(f"点零钱失败: {json.dumps(res, ensure_ascii=False)[:500]}")
    time.sleep(2)

def save_screenshot_to_local():
    print("Step 7: 截图")
    res = cmd({"command": "device.screen", "machine": MACHINE}, timeout=60)
    if not res.get("ok"):
        raise RuntimeError(f"device.screen failed: {res}")
    # 从 stdout 解析截图路径
    stdout = res.get("stdout", "")
    try:
        data = json.loads(stdout)
        screenshot_path = data["results"][0]["screenshotPath"]
    except Exception as e:
        raise RuntimeError(f"无法解析截图路径: {e}, stdout={stdout[:500]}")
    return screenshot_path

def ocr_read_amount(image_path):
    print(f"Step 8: 本地 OCR 读取金额: {image_path}")
    if not os.path.exists(image_path):
        raise RuntimeError(f"截图不存在: {image_path}")
    proc = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", PS_OCR, "-ImagePath", image_path, "-Mode", "currency_amount"],
        capture_output=True, text=True, timeout=60, encoding="utf-8"
    )
    if proc.returncode != 0:
        raise RuntimeError(f"OCR 失败: {proc.stderr}")
    result = json.loads(proc.stdout)
    return result

def main():
    try:
        navigate_to_change_page()
        screenshot_path = save_screenshot_to_local()
        ocr_result = ocr_read_amount(screenshot_path)

        print("\n=== 结果 ===")
        print(json.dumps({
            "machine": MACHINE,
            "screenshot": screenshot_path,
            "ocr": ocr_result,
        }, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"\n=== 失败 ===\n{str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()
