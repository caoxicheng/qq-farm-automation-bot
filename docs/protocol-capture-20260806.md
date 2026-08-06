2026-08-06T06:43:26.581Z [[33mwarn[39m] [system] Node.js 环境不提供小游戏函数完整性列表 {"tag":"系统"}
2026-08-06T06:43:26.582Z [[32minfo[39m] [system] 新版 TSDK 初始化成功: v3.8.6.1785239995 {"tag":"系统"}
2026-08-06T06:43:26.583Z [[32minfo[39m] [system] 正在加载 Protobuf 定义... {"tag":"系统"}
2026-08-06T06:43:26.594Z [[32minfo[39m] [system] Protobuf 定义加载完成 {"tag":"系统"}
# 抓包字段级协议说明

> 帧数: 602 | 协议组: 20

## gamepb.userpb.UserService.Login · `gamepb.userpb.LoginRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 3 | sharer_id | int64 | 0 |
| 4 | sharer_open_id | string |  |
| 5 | device_info | DeviceInfo | {"client_version":"1.13.0.5_20260723","sys_software":"Mac OS X 26.1.0 arm64","ne |
| 6 | share_cfg_id | int64 | 0 |
| 7 | scene_id | string | 1256 |
| 8 | report_data | ReportData | {"callback":"","cd_extend_info":"","click_id":"","clue_token":"","minigame_chann |
| 9 | field_9 | bytes |  |

> 共 2 帧（roundtrip 一致）。

## gamepb.mysteryshoppb.MysteryShopService.GetActiveNPC · `GetActiveNPCRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|

> 共 2 帧（roundtrip 一致）。

## gamepb.plantpb.PlantService.AllLands · `gamepb.plantpb.AllLandsRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | host_gid | int64 |  |

> 共 2 帧（roundtrip 一致）。

## gamepb.taskpb.TaskService.TaskInfo · `gamepb.taskpb.TaskInfoRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|

> 共 4 帧（roundtrip 一致）。

## gamepb.seasonpb.SeasonService.GetSeasonInfo · `gamepb.seasonpb.GetSeasonInfoRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | season_id | int32 | 1 |

> 共 2 帧（roundtrip 一致）。

## gamepb.emailpb.EmailService.GetEmailList · `gamepb.emailpb.GetEmailListRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | box_type | int32 | 1 |

> 共 4 帧（roundtrip 一致）。

## gamepb.redpacketpb.RedPacketService.GetTodayClaimStatus · `GetTodayClaimStatusRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|

> 共 2 帧（roundtrip 一致）。

## gamepb.friendpb.FriendService.GetAll · `gamepb.friendpb.GetAllRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|

> 共 2 帧（roundtrip 一致）。

## gamepb.mallpb.MallService.GetMallListBySlotType · `GetMallListBySlotTypeRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | slot_type | int32 | 1 |
| 2 | sub_slot_type | int32 | 1 |

> 共 2 帧（roundtrip 一致）。

## gamepb.shoppb.ShopService.ShopInfo · `gamepb.shoppb.ShopInfoRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | shop_id | int64 | 2 |

> 共 2 帧（roundtrip 一致）。

## gamepb.itempb.ItemService.Bag · `gamepb.itempb.BagRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|

> 共 2 帧（roundtrip 一致）。

## gamepb.acepb.AceService.AntiData · `gamepb.acepb.AntiDataRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | data | bytes | BwWL6np6AAAAAAAAARrjpCe3Lt+UkKcUWgI4ebItXTk63stTZS1nJ7YxUNihYlNtUtUpdXbuLDTfvBV1 |

> 共 254 帧（roundtrip 一致）。

## gamepb.userpb.UserService.Heartbeat · `gamepb.userpb.HeartbeatRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | gid | int64 | 1237486904 |
| 2 | client_version | string | 1.13.0.5_20260723 |
| 3 | field_3 | int32 | 0 |

> 共 202 帧（roundtrip 一致）。

## gamepb.mysteryshoppb.MysteryShopService.Buy · `BuyRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | npc_id | int64 | 1008 |
| 2 | count | int32 |  |

> 共 2 帧（roundtrip 一致）。

## gamepb.plantpb.PlantService.Harvest · `gamepb.plantpb.HarvestRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | land_ids | repeated int64 | ["15","16"] |
| 2 | host_gid | int64 | 1237486904 |
| 3 | is_all | bool | true |
| 4 | field_4 | int32 | 0 |
| 5 | field_5 | int32 | 0 |

> 共 2 帧（roundtrip 一致）。

## gamepb.visitpb.VisitService.Enter · `EnterRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | host_gid | int64 | 1092772766 |
| 2 | reason | int32 | 1 |
| 3 | field_3 | int32 | 0 |
| 7 | field_7 | bytes |  |

> 共 6 帧（roundtrip 一致）。

## gamepb.friendpb.FriendService.GetGameFriends · `gamepb.friendpb.GetGameFriendsRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | gids | repeated int64 | ["1245914064","1243904411","1242624233","1239348288","1246450646"] |

> 共 20 帧（roundtrip 一致）。

## gamepb.visitpb.VisitService.Leave · `LeaveRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | host_gid | int64 | 1092772766 |
| 2 | field_2 | int32 | 0 |

> 共 4 帧（roundtrip 一致）。

## gamepb.plantpb.PlantService.PutWeeds · `gamepb.plantpb.PutWeedsRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | host_gid | int64 | 1155545955 |
| 2 | land_ids | repeated int64 | ["15"] |
| 3 | field_3 | int32 | 0 |
| 4 | field_4 | int32 | 2 |

> 共 56 帧（roundtrip 一致）。

## gamepb.plantpb.PlantService.PutInsects · `gamepb.plantpb.PutInsectsRequest` ✅

| 字段号 | 字段名 | 类型 | 样例值 |
|---|---|---|---|
| 1 | host_gid | int64 | 1155545955 |
| 2 | land_ids | repeated int64 | ["20"] |
| 3 | field_3 | int32 | 0 |
| 4 | field_4 | int32 | 2 |

> 共 30 帧（roundtrip 一致）。

---
统计：20 组协议 roundtrip 一致，0 组存在差异。
