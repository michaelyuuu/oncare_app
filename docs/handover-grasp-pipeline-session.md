# 交接 Prompt — 抓取（pick-and-place）pipeline 開發 session

把下面整段貼給另一個 Claude Code session。它的工作目錄應該是
`D:/ontaru/AGI carehouse/on_software_all`，**不是** `oncare_app`。

---

你負責為 Ontaru / reBot 雙臂移動機器人開發**受限場景的自主取物 pipeline**：
在一個固定的取物站（桌子或托盤），偵測三種核准的剛性物品之一，用一隻手臂抓起，
放到一個核准的平面（床邊桌或托盤），並回報每一步的狀態。這是 AGI Carehouse
「家屬對機器人」照護平台的機器人端能力；app、雲端 API 和 Robot Gateway 由
**另一個 session** 在 `D:/ontaru/AGI carehouse/oncare_app` 開發，你不要碰那個 repo。

## 0. 先讀，再動手

1. `README.md`、`CLAUDE.md`、`docs/OPERATING.md`（本 repo 根目錄）。
2. `robot/CLAUDE.md`（很長，硬體歷史都在裡面）、`teleop/README.md`（安全鏈）、
   `folding/docs/`（資料集設計、研究、事故報告）。
3. `folding/docs/incident-2026-09-02-left-j6.md`，以及 `config/rig.env` 的左腕窗口值。

先做唯讀調查，寫一份簡短的現況報告（有什麼、缺什麼、哪些是硬阻礙），再提方案，
**方案經 owner 同意後才寫 code**。

## 1. 不可違反的規則（來自本 repo 的 CLAUDE.md，這裡只是提醒）

- **不修改 `teleop/`。** 它有事故史和已驗證的雙臂執行紀錄。要整合就用它提供的接縫
  （`motor_log.MotorLogger` 是唯讀觀察者；`so101-remote` UDP 協定是唯一的外部命令路徑），
  或另開平行路徑。若真的需要改它，先提出，不要直接改。
- **永遠不寫馬達 CAN ID。**
- **永遠不跑 SDK 的 `example/2_zero_and_read.py`。** 讀取用 `teleop/rebot_read.py`。
- **兩隻手臂倒吊。** 任何會動手臂的步驟都要有人站在機器人旁邊；`RebotArm.disconnect()`、
  `q`、`x`、斷電都會讓手臂掉下來。
- **不要為了「修正」而重新指向一個正在運作的系統依賴的路徑或設定。** 加平行路徑，原路保留。
- 左腕 j6 窗口 `[-4.526, -1.153]`、rest `-3.1416` 是**量測值**。若 `ontaru doctor` 的檢查觸發，
  不要改期望值，去找哪棵樹是活的。

## 2. 已知現況（另一個 session 做過唯讀調查，供你核對，不要照抄，要自己驗證）

- ROS 2 Jazzy、Ubuntu 24.04、系統 Python 3.12；手臂+相機+錄製在 `~/ontaru312`（uv）一個程序裡。
- 相機：胸口是 **D455**（不是 D435），兩腕 D405。序號在 `teleop/teleop_cameras.json`。
  `teleop/camera_stream.py` 用 pyrealsense2 讀三台的彩色介面；ROS RealSense driver 只拿 D455 的深度介面
  （`robot/mobile/slam/nvblox_d455.launch.py`，預設 `color:=false`）。
- 手臂：Seeed reBot Arm B601，Damiao 馬達，MIT 模式走 USB-CAN；`teleop/rebot_teleop.py` 只有四種輸入模式
  `quest | keyboard | so101 | so101-remote`，**沒有** policy / 腳本 / RPC 模式。
- IK：`teleop/rebot_real_ik_test.py:_solve_pos_ik` 是 pinocchio 的**只控位置**DLS IK；
  owner 自己註記「冗餘自由度會亂飄，接近軸擺到 95°，會擋住任何自主動作」。
- 安全鏈 `raw target → FloorGuard → TargetLimiter → DualArmGuard → clamp_error → send_mit`
  在 `teleop/safety.py`，是純 Python 類別，可以在程序內匯入使用；目前會裁掉 17.7% 的指令 tick，joint4 最嚴重。
- **完全沒有**物件偵測、分割、抓取姿態估計。唯一的 3D 感知是 nvblox（給 costmap 用）。
- `folding/` 只有資料集 schema、錄製、研究；**沒有** pi0 推論程式。
  `folding/docs/research/research_edge_inference.md` 估 π0.5 在 Orin 上原生 PyTorch 約 0.7 Hz。
- **沒有實體急停按鈕**（`base_controller.py:14` 只是建議）。升降柱在硬體急停迴路之外。
- 健康狀態：`GET :5808/health.json`；心跳：`robot/mobile/common/heartbeat.py` 的 `Emitter`。

## 3. 你要交付的介面（Robot Gateway 會呼叫這個）

Gateway 那邊的任務狀態機（節錄）：

```
queued → navigating_to_pickup → locating_item → grasping → verifying_grasp
       → navigating_to_delivery → placing → verifying_delivery → completed
失敗出口：item_not_found | grasp_failed | operator_required | cancelled | safety_stopped
```

導航兩段由 Gateway 自己透過 `nav_web` 的 HTTP 做，**你只負責中間的操作段**。
請把 pipeline 包成下面這個合約（Python 3.12，可放在你選的模組裡；名稱可調，語意不要變）：

```python
from typing import Callable, Literal, Protocol, TypedDict

ManipState = Literal[
    "locating_item", "grasping", "verifying_grasp", "placing", "verifying_delivery", "completed",
    "item_not_found", "grasp_failed", "operator_required", "cancelled", "safety_stopped",
]

class PickPlaceRequest(TypedDict):
    correlation_id: str      # Gateway 給的任務 ID，所有事件都要帶回來
    item_id: str             # "water_bottle" | "tissue_box" | "tv_remote"（核准清單，Gateway 已驗證過）
    pickup_station_id: str   # 固定取物站，例如 "pickup_station_demo"
    destination_id: str      # 核准平面，例如 "bedside_table_demo" | "delivery_tray_demo"
    arm: Literal["left", "right"]
    deadline_ns: int         # 超過就自行進入 operator_required

class StateEvent(TypedDict):
    correlation_id: str
    state: ManipState
    at_ns: int               # 量測時間戳，不是 frame_index / fps
    reason: str | None       # 失敗或需要人介入時的可讀原因
    detail: dict | None      # 例如 {"attempt": 2, "grasp_score": 0.81}

class ManipulationAdapter(Protocol):
    def health(self) -> dict: ...                       # 手臂、相機、標定是否就緒；Gateway 用它決定 robot_ready
    def start(self, req: PickPlaceRequest, on_state: Callable[[StateEvent], None]) -> None: ...
    def cancel(self, correlation_id: str) -> None: ...  # 安全地收尾，回到已知姿勢，回報 cancelled
    def safety_stop(self) -> None: ...                  # 立即停止；記住倒吊手臂的後果，設計時要有人在場
```

規則：

- `start` 非阻塞，事件依序回呼；每個狀態至少回報一次；終態只回報一次。
- 允許一次重試（`verifying_grasp → grasping`），第二次失敗回 `grasp_failed`。
- 放置只能放在核准的平面上，**永遠不放進人的手裡**，不接觸住民身體。
- 任何無法恢復的情況進 `operator_required` 並讓手臂停在已知安全姿勢，不要拋例外給呼叫端。
- 提供一個 `MockManipulationAdapter`，用固定延遲和可注入的失敗走完整個狀態序列，
  Gateway 沒硬體時用它。

**你決定實際的呼叫方式**（同程序 Python 函式、ROS 2 action、還是本機 HTTP/UDP），
決定後把入口（模組路徑、埠、訊息格式）回報給主對話，Gateway 那邊會照你的介面寫 adapter。

## 4. Benchmark（交接文件第 10 節）

- 一個取物站、三種核准的剛性物品、每種 5 個擺放姿態、3 種光照 = **45 次試驗**。
- 一隻手臂為主，另一隻維持已知安全姿勢。
- D455 找工作區和目標，D405 做近距離姿態修正和抓取驗證。
- 每次記錄：偵測成功、3D 定位誤差（若有參考）、首次抓取成功、一次重試後成功、完成時間、
  掉落、碰桌／碰環境、人員介入、失敗類別。**保留每次試驗的結果**，不要只為一次錄影調參。
- 目標：偵測 ≥ 95%、首次抓取 ≥ 70%、一次重試內 ≥ 85%、零危險碰撞、
  每個不可恢復失敗都進入安全停止／需要操作員的狀態。

## 5. 範圍與邊界

- 只在 `D:/ontaru/AGI carehouse/on_software_all` 工作，**開新分支**（建議 `grasp-pipeline`），
  各自 commit。不要動 `oncare_app`。
- 放在哪裡由你提案：`robot/` 底下的新目錄、新的頂層目錄、或新的子模組。不要放進 `teleop/`。
- 主 session 對本 repo 只做唯讀調查；如果你切分支或改子模組 pin，它的調查結果可能過期，
  在主對話說一聲即可。
- 兩個 session 不要同時編輯同一個檔案。目前 `oncare_app` session 沒碰過本 repo 任何檔案。
- 用 TDD：先寫失敗的測試再寫實作；沒硬體的部分（schema、狀態序列、mock adapter、失敗注入）
  必須能在沒有機器人的機器上 `pytest -m 'not hardware'` 通過。
- 不要宣稱任何「已在真機驗證」除非你真的跑過並記錄在 `folding/docs/jetson-migration-log.md`
  那種等級的紀錄裡。

## 6. 第一次回覆的格式

1. 現況摘要（5–10 句，有檔案行號）。
2. 抓取 pipeline 的 2–3 個方案（例如：AprilTag/已知物件 + 腳本化抓取 vs. 開放偵測 + 抓取姿態估計 vs.
   先錄資料訓練 policy），各自的可靠度、兩週內可達成度、風險，附建議。
3. 你打算怎麼在不改 `teleop/` 的前提下命令手臂（UDP leader 協定？程序內 `arm.set_target`？），
   以及倒吊手臂在失敗時怎麼安全收尾。
4. 需要 owner 決定的事（例如：是否先裝實體急停、是否允許新增 `--input` 模式進 `teleop/`）。
5. 建議的第一個 code change（檔案、內容），等同意再動手。
