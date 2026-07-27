import React, { useCallback } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { RootNavigator } from './src/navigation/RootNavigator';
import { colors } from './src/theme/colors';

if (Platform.OS === 'web') {
  require('./src/webSetup');
}

SplashScreen.preventAutoHideAsync().catch(() => undefined);

/**
 * 웹(GitHub Pages)에서는 대용량 TTF 번들 대신 CDN 폰트를 씁니다.
 * 폰트 로드 실패로 스플래시에 멈추지 않도록 바로 앱을 렌더합니다.
 */
export default function App() {
  const onLayout = useCallback(async () => {
    await SplashScreen.hideAsync().catch(() => undefined);
  }, []);

  return (
    <SafeAreaProvider onLayout={onLayout} style={styles.provider}>
      <StatusBar style="light" />
      <View style={styles.appRoot}>
        <RootNavigator />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  provider: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.ink,
    ...(Platform.OS === 'web'
      ? ({ height: '100%', maxHeight: '100%', overflow: 'hidden' } as object)
      : null),
  },
  appRoot: {
    flex: 1,
    minHeight: 0,
    ...(Platform.OS === 'web'
      ? ({ height: '100%', maxHeight: '100%', overflow: 'hidden' } as object)
      : null),
  },
});
