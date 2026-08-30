---@meta

-- QB Studio's curated QBCore LuaCATS definitions. This pack is maintained
-- separately from the generated FiveM and RedM engine definitions.

---@alias QBCoreHash integer|string
---@alias QBCorePlayerId integer
---@alias QBCoreMoneyType 'cash'|'bank'|'crypto'

---@class QBCorePlayerData
---@field citizenid string
---@field cid integer
---@field source QBCorePlayerId
---@field license string
---@field name string
---@field money table<QBCoreMoneyType, number>
---@field charinfo table
---@field job table
---@field gang table
---@field metadata table
---@field position vector3|vector4|table
---@field items table[]

---@class QBCorePlayerFunctions
---@field UpdatePlayerData fun(self: QBCorePlayerFunctions)
---@field SetJob fun(self: QBCorePlayerFunctions, job: string, grade?: integer|string): boolean
---@field SetGang fun(self: QBCorePlayerFunctions, gang: string, grade?: integer|string): boolean
---@field SetJobDuty fun(self: QBCorePlayerFunctions, onDuty: boolean)
---@field SetPlayerData fun(self: QBCorePlayerFunctions, key: string, value: any)
---@field SetMetaData fun(self: QBCorePlayerFunctions, key: string, value: any)
---@field GetMetaData fun(self: QBCorePlayerFunctions, key: string): any
---@field AddMoney fun(self: QBCorePlayerFunctions, moneyType: QBCoreMoneyType, amount: number, reason?: string): boolean
---@field RemoveMoney fun(self: QBCorePlayerFunctions, moneyType: QBCoreMoneyType, amount: number, reason?: string): boolean
---@field SetMoney fun(self: QBCorePlayerFunctions, moneyType: QBCoreMoneyType, amount: number, reason?: string): boolean
---@field GetMoney fun(self: QBCorePlayerFunctions, moneyType: QBCoreMoneyType): number
---@field AddItem fun(self: QBCorePlayerFunctions, item: string, amount: integer, slot?: integer|boolean, info?: table, reason?: string): boolean
---@field RemoveItem fun(self: QBCorePlayerFunctions, item: string, amount: integer, slot?: integer|boolean, reason?: string): boolean
---@field GetItemByName fun(self: QBCorePlayerFunctions, item: string): table?
---@field GetItemBySlot fun(self: QBCorePlayerFunctions, slot: integer): table?
---@field Save fun(self: QBCorePlayerFunctions)
---@field Logout fun(self: QBCorePlayerFunctions)

---@class QBCorePlayer
---@field PlayerData QBCorePlayerData
---@field Functions QBCorePlayerFunctions

---@class QBCoreServerFunctions
---@field GetPlayer fun(source: QBCorePlayerId): QBCorePlayer?
---@field GetPlayerByCitizenId fun(citizenId: string): QBCorePlayer?
---@field GetPlayerByPhone fun(phone: string): QBCorePlayer?
---@field GetQBPlayers fun(): table<QBCorePlayerId, QBCorePlayer>
---@field GetPlayers fun(): QBCorePlayerId[]
---@field CreateCallback fun(name: string, handler: fun(source: QBCorePlayerId, callback: fun(...), ...))
---@field TriggerCallback fun(name: string, source: QBCorePlayerId, callback: fun(...), ...)
---@field HasPermission fun(source: QBCorePlayerId, permission: string|string[]): boolean
---@field AddPermission fun(source: QBCorePlayerId, permission: string)
---@field RemovePermission fun(source: QBCorePlayerId, permission?: string)
---@field Notify fun(source: QBCorePlayerId, text: string|table, notifyType?: string, duration?: integer)

---@class QBCoreClientFunctions
---@field GetPlayerData fun(callback?: fun(data: QBCorePlayerData)): QBCorePlayerData
---@field GetCoords fun(entity: integer): vector4
---@field HasItem fun(items: string|string[]|table<string, integer>, amount?: integer): boolean
---@field Notify fun(text: string|table, notifyType?: string, duration?: integer, subTitle?: string, notifyPosition?: string, notifyStyle?: table, notifyIcon?: string, notifyIconColor?: string)
---@field TriggerCallback fun(name: string, callback: fun(...), ...)
---@field GetVehicles fun(): integer[]
---@field GetPlayers fun(): QBCorePlayerId[]
---@field GetClosestPlayer fun(coords?: vector3): QBCorePlayerId, number
---@field GetClosestVehicle fun(coords?: vector3): integer, number
---@field SpawnVehicle fun(model: QBCoreHash, callback: fun(vehicle: integer), coords?: vector4, isNetworked?: boolean)
---@field DeleteVehicle fun(vehicle: integer)
---@field Progressbar fun(name: string, label: string, duration: integer, useWhileDead: boolean, canCancel: boolean, disableControls: table, animation?: table, prop?: table, propTwo?: table, onFinish?: fun(), onCancel?: fun())

---@class QBCoreShared
---@field Items table<string, table>
---@field Jobs table<string, table>
---@field Gangs table<string, table>
---@field Vehicles table<string, table>
---@field Weapons table<string, table>
---@field StarterItems table<string, integer>
---@field SplitStr fun(value: string, delimiter?: string): string[]
---@field Trim fun(value: string): string
---@field Round fun(value: number, decimalPlaces?: integer): number

---@class QBCoreCommands
---@field Add fun(name: string|string[], help: string, arguments: table[], argsRequired: boolean, callback: fun(source: QBCorePlayerId, args: string[]), permission?: string, ...: any)
---@field Refresh fun(source: QBCorePlayerId)

---@class QBCoreObject
---@field Functions QBCoreServerFunctions|QBCoreClientFunctions
---@field Shared QBCoreShared
---@field Commands QBCoreCommands
---@field Players table<QBCorePlayerId, QBCorePlayer>
---@field ServerCallbacks table<string, function>
---@type QBCoreObject
QBCore = {}
