param(
    [string]$BaseToken = $env:LARK_BASE_TOKEN,
    [string]$TableId = $env:LARK_TABLE_ID,
    [string]$InventoryCsv,
    [string]$ApprovedAliasesCsv
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$InventoryCsv) { $InventoryCsv = Join-Path $projectRoot "data\phone-assets.csv" }
. (Join-Path $PSScriptRoot "Lark-InventoryPolicy.ps1")

if (!(Test-Path -LiteralPath $InventoryCsv -PathType Leaf)) {
    throw "找不到待同步的脱敏设备清单"
}
if (!$ApprovedAliasesCsv) {
    throw "同步飞书需要来自本地设备映射的 ApprovedAliasesCsv；尚未发送任何外部请求"
}
$approvedAliases = @($ApprovedAliasesCsv -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$inventory = @(Import-Csv -LiteralPath $InventoryCsv -Encoding UTF8)
$null = Assert-LarkSafeInventoryRows -Rows $inventory -ApprovedAliases $approvedAliases

Set-Location $projectRoot
$payloadDir = Join-Path $projectRoot "data\lark_payloads"
$payloadFile = Join-Path $payloadDir "current.json"
$payloadArg = "@data/lark_payloads/current.json"
New-Item -ItemType Directory -Force -Path $payloadDir | Out-Null

if (!$BaseToken -or !$TableId) {
    throw "请通过参数或环境变量 LARK_BASE_TOKEN / LARK_TABLE_ID 提供飞书 Base Token 和 Table ID"
}

function Invoke-LarkJson {
    param([string[]]$Arguments)
    $raw = & lark-cli @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $raw }
    $start = $raw.IndexOf('{')
    if ($start -lt 0) { throw "lark-cli 未返回 JSON：$raw" }
    $raw.Substring($start) | ConvertFrom-Json
}

function Get-AllLarkRecordRows {
    param([string]$BaseTokenValue, [string]$TableIdValue)
    $rows = @()
    $offset = 0
    $seenRecordIds = @{}
    $pageSize = 200
    for ($page = 0; $page -lt 1000; $page++) {
        # The installed lark-cli record-list contract is offset based and caps
        # each page at 200 rows. Project only the safe alias field.
        $arguments = @(
            "base", "+record-list",
            "--base-token", $BaseTokenValue,
            "--table-id", $TableIdValue,
            "--field-id", "设备编号",
            "--as", "user",
            "--limit", ([string]$pageSize),
            "--offset", ([string]$offset),
            "--format", "json"
        )
        $response = Invoke-LarkJson $arguments
        $data = $response.data
        if (!$data) { throw "飞书记录列表缺少 data；同步尚未写入任何字段或记录" }
        $fieldNames = @($data.fields)
        $recordIds = @($data.record_id_list)
        $valueRows = @($data.data)
        if ($recordIds.Count -ne $valueRows.Count) {
            throw "飞书记录列表的记录和值数量不一致；同步尚未写入任何字段或记录"
        }
        for ($i = 0; $i -lt $recordIds.Count; $i++) {
            $recordId = [string]$recordIds[$i]
            if (!$recordId -or $seenRecordIds.ContainsKey($recordId)) {
                throw "飞书记录分页返回空或重复记录；同步尚未写入任何字段或记录"
            }
            $seenRecordIds[$recordId] = $true
            $values = @($data.data[$i])
            $map = @{}
            for ($j = 0; $j -lt $fieldNames.Count; $j++) { $map[$fieldNames[$j]] = $values[$j] }
            $rows += [pscustomobject]@{ id = $recordId; values = $map; used = $false }
        }

        if ($recordIds.Count -lt $pageSize) { return $rows }
        $offset += $recordIds.Count
    }
    throw "飞书记录分页超过安全上限；同步尚未写入任何字段或记录"
}

function Save-Payload {
    param($Value)
    $json = $Value | ConvertTo-Json -Depth 10 -Compress
    [System.IO.File]::WriteAllText($payloadFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$fieldDefinitions = @(
    [ordered]@{ name = "设备编号"; type = "text"; description = "本地配置的安全设备别名；不保存硬件或网络标识" },
    [ordered]@{ name = "手机型号"; type = "text" },
    [ordered]@{ name = "品牌"; type = "text" },
    [ordered]@{ name = "Android版本"; type = "text" },
    [ordered]@{ name = "安全补丁"; type = "text" },
    [ordered]@{ name = "分辨率"; type = "text" },
    [ordered]@{ name = "屏幕密度"; type = "number"; style = [ordered]@{ type = "plain"; precision = 0; percentage = $false; thousands_separator = $false } },
    [ordered]@{ name = "电量"; type = "number"; style = [ordered]@{ type = "plain"; precision = 0; percentage = $false; thousands_separator = $false } },
    [ordered]@{ name = "小红书版本"; type = "text" },
    [ordered]@{ name = "页面结构已采集"; type = "checkbox" },
    [ordered]@{ name = "采集时间"; type = "datetime"; style = [ordered]@{ format = "yyyy-MM-dd HH:mm" } }
)
$approvedFieldNames = @(Get-LarkInventoryApprovedFieldNames)
$definitionNames = @($fieldDefinitions | ForEach-Object { $_.name })
$fieldPolicyDifference = @(Compare-Object -ReferenceObject $approvedFieldNames -DifferenceObject $definitionNames)
if ($fieldPolicyDifference.Count) {
    throw "飞书字段定义与固定隐私白名单不一致；尚未发送任何外部请求"
}

$fieldList = Invoke-LarkJson @("base", "+field-list", "--base-token", $BaseToken, "--table-id", $TableId, "--as", "user", "--format", "json")
$existingNames = @($fieldList.data.fields | ForEach-Object { $_.name })
$recordRows = @(Get-AllLarkRecordRows -BaseTokenValue $BaseToken -TableIdValue $TableId)

foreach ($definition in $fieldDefinitions) {
    if ($existingNames -contains $definition.name) { continue }
    Save-Payload $definition
    $created = Invoke-LarkJson @("base", "+field-create", "--base-token", $BaseToken, "--table-id", $TableId, "--json", $payloadArg, "--as", "user", "--format", "json")
    Write-Host "已创建字段：$($created.data.field.name)"
}

foreach ($device in $inventory) {
    $target = $recordRows | Where-Object {
        !$_.used -and $_.values["设备编号"] -eq $device."设备编号"
    } | Select-Object -First 1

    $payload = [ordered]@{
        "设备编号" = $device."设备编号"
        "手机型号" = $device."手机型号"
        "品牌" = $device."品牌"
        "Android版本" = $device."Android版本"
        "安全补丁" = $device."安全补丁"
        "分辨率" = $device."分辨率"
        "屏幕密度" = if ($device."屏幕密度") { [double]$device."屏幕密度" } else { $null }
        "电量" = if ($device."电量") { [double]$device."电量" } else { $null }
        "小红书版本" = $device."小红书版本"
        "页面结构已采集" = [System.Convert]::ToBoolean($device."页面结构已采集")
        "采集时间" = $device."采集时间"
    }
    $unexpectedPayloadFields = @($payload.Keys | Where-Object { $_ -notin (Get-LarkInventoryApprovedFieldNames) })
    if ($unexpectedPayloadFields.Count) { throw "同步负载包含未批准字段；尚未写入该记录" }
    Save-Payload $payload
    $args = @("base", "+record-upsert", "--base-token", $BaseToken, "--table-id", $TableId, "--json", $payloadArg, "--as", "user", "--format", "json")
    if ($target) {
        $args += @("--record-id", $target.id)
        $target.used = $true
    }
    $saved = Invoke-LarkJson $args
    Write-Host "已同步设备别名：$($device.'设备编号')"
}

Write-Host "飞书多维表格同步完成"
