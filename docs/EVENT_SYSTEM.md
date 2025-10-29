# EventEmitter Pattern - Usage Guide

このドキュメントでは、ChargePointとConnectorの新しいイベントシステムの使い方を説明します。

## 概要

従来のcallbackベースのシステムから、型安全なEventEmitterパターンに移行しました。これにより：

- **型安全性**: TypeScriptによる完全な型チェック
- **複数のリスナー**: 1つのイベントに複数のリスナーを登録可能
- **自動クリーンアップ**: unsubscribe関数による簡単なクリーンアップ
- **エラーハンドリング**: リスナー内のエラーを自動的にキャッチ

## ChargePoint イベント

### 利用可能なイベント

```typescript
interface ChargePointEvents {
  // ステータスイベント
  statusChange: { status: OCPPStatus; message?: string };
  error: { error: string };

  // 接続イベント
  connected: void;
  disconnected: { code: number; reason: string };

  // コネクタイベント
  connectorStatusChange: {
    connectorId: number;
    status: OCPPStatus;
    previousStatus: OCPPStatus;
  };
  connectorAvailabilityChange: {
    connectorId: number;
    availability: OCPPAvailability;
  };
  connectorTransactionChange: {
    connectorId: number;
    transactionId: number | null;
  };

  // トランザクションイベント
  transactionStarted: {
    connectorId: number;
    transactionId: number;
    tagId: string;
  };
  transactionStopped: {
    connectorId: number;
    transactionId: number;
  };

  // ログイベント
  log: {
    timestamp: Date;
    level: number;
    type: string;
    message: string;
  };
}
```

### 使用例

#### 基本的な使い方

```typescript
import { ChargePoint } from './cp/ChargePoint';

const chargePoint = new ChargePoint(/* ... */);

// ステータス変更をリッスン
const unsubscribe = chargePoint.events.on('statusChange', (data) => {
  console.log('Status changed to:', data.status);
});

// リスナーの解除
unsubscribe();
```

#### React コンポーネントでの使用

```typescript
import React, { useEffect, useState } from 'react';
import { ChargePoint as OCPPChargePoint } from '../cp/ChargePoint';
import { OCPPStatus } from '../cp/OcppTypes';

interface Props {
  cp: OCPPChargePoint;
}

const ChargePointStatus: React.FC<Props> = ({ cp }) => {
  const [status, setStatus] = useState<OCPPStatus>(cp.status);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    // ステータス変更のリスナー
    const unsubStatus = cp.events.on('statusChange', (data) => {
      setStatus(data.status);
    });

    // エラーのリスナー
    const unsubError = cp.events.on('error', (data) => {
      setError(data.error);
    });

    // 接続イベントのリスナー
    const unsubConnected = cp.events.on('connected', () => {
      console.log('ChargePoint connected!');
    });

    // クリーンアップ
    return () => {
      unsubStatus();
      unsubError();
      unsubConnected();
    };
  }, [cp]);

  return (
    <div>
      <p>Status: {status}</p>
      {error && <p className="error">{error}</p>}
    </div>
  );
};
```

#### 一度だけ実行するリスナー

```typescript
// 接続イベントを一度だけ処理
chargePoint.events.once('connected', () => {
  console.log('Connected for the first time!');
  // このリスナーは自動的に解除されます
});
```

#### トランザクションの監視

```typescript
useEffect(() => {
  const unsubStart = cp.events.on('transactionStarted', (data) => {
    console.log(`Transaction started on connector ${data.connectorId}`);
    console.log(`Tag: ${data.tagId}, Transaction ID: ${data.transactionId}`);
  });

  const unsubStop = cp.events.on('transactionStopped', (data) => {
    console.log(`Transaction ${data.transactionId} stopped`);
  });

  return () => {
    unsubStart();
    unsubStop();
  };
}, [cp]);
```

## Connector イベント

### 利用可能なイベント

```typescript
interface ConnectorEvents {
  statusChange: { status: OCPPStatus; previousStatus: OCPPStatus };
  transactionIdChange: { transactionId: number | null };
  meterValueChange: { meterValue: number };
  availabilityChange: { availability: OCPPAvailability };
}
```

### 使用例

```typescript
const connector = chargePoint.getConnector(1);

if (connector) {
  // ステータス変更のリスナー
  const unsubStatus = connector.events.on('statusChange', (data) => {
    console.log(`Status changed from ${data.previousStatus} to ${data.status}`);
  });

  // メーター値の変更のリスナー
  const unsubMeter = connector.events.on('meterValueChange', (data) => {
    console.log(`Meter value: ${data.meterValue}`);
  });

  // クリーンアップ
  return () => {
    unsubStatus();
    unsubMeter();
  };
}
```

## マイグレーション完了

**注意**: Legacy callbackシステムは完全に削除されました。すべてのコードでEventEmitterパターンを使用してください。

```typescript
// ✅ 正しい方法（EventEmitterのみ）
chargePoint.events.on('statusChange', (data) => {
  console.log('Status:', data.status);
});

// ❌ 削除されたAPI（使用不可）
// chargePoint.statusChangeCallback = ...
// chargePoint.setConnectorStatusChangeCallback(...)
// これらのメソッドは存在しません
```

## ベストプラクティス

### 1. 常にクリーンアップする

```typescript
useEffect(() => {
  const unsubscribe = cp.events.on('statusChange', handler);

  // 必ずクリーンアップ関数を返す
  return () => {
    unsubscribe();
  };
}, [cp]);
```

### 2. 複数のイベントを効率的に管理

```typescript
useEffect(() => {
  const unsubscribers = [
    cp.events.on('connected', handleConnected),
    cp.events.on('disconnected', handleDisconnected),
    cp.events.on('error', handleError),
  ];

  return () => {
    unsubscribers.forEach(unsub => unsub());
  };
}, [cp]);
```

### 3. 条件付きリスナー

```typescript
useEffect(() => {
  if (!enableLogging) return;

  const unsubscribe = cp.events.on('log', (data) => {
    console.log(data.message);
  });

  return () => {
    unsubscribe();
  };
}, [cp, enableLogging]);
```

## エラーハンドリング

EventEmitterは自動的にリスナー内のエラーをキャッチします：

```typescript
cp.events.on('statusChange', (data) => {
  // このエラーはキャッチされ、コンソールにログ出力されます
  throw new Error('Something went wrong!');
  // アプリケーションはクラッシュしません
});
```

## クリーンアップ

コンポーネントのアンマウント時や不要になった際は、必ずクリーンアップを行ってください：

```typescript
// ChargePointの完全なクリーンアップ
chargePoint.cleanup();

// Connectorの完全なクリーンアップ
connector.cleanup();
```

## まとめ

EventEmitterパターンのメリット：

- ✅ 型安全なイベント処理
- ✅ メモリリークの防止
- ✅ 複数のリスナーのサポート
- ✅ 簡単なクリーンアップ
- ✅ シンプルで統一されたAPI

**重要**: すべてのコードでEventEmitterパターンを使用してください。Legacy callbackシステムは完全に削除されています。
