import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  NotoSansKR_400Regular,
  NotoSansKR_500Medium,
  NotoSansKR_700Bold,
} from '@expo-google-fonts/noto-sans-kr';
import {
  NotoSerifKR_600SemiBold,
  NotoSerifKR_700Bold,
} from '@expo-google-fonts/noto-serif-kr';
import * as SplashScreen from 'expo-splash-screen';
import { RootNavigator } from './src/navigation/RootNavigator';
import { colors } from './src/theme/colors';

if (Platform.OS === 'web') {
  require('./src/webSetup');
}

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function App() {
  const [fontsLoaded] = useFonts({
    NotoSansKR_400Regular,
    NotoSansKR_500Medium,
    NotoSansKR_700Bold,
    NotoSerifKR_600SemiBold,
    NotoSerifKR_700Bold,
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (fontsLoaded) setReady(true);
  }, [fontsLoaded]);

  const onLayout = useCallback(async () => {
    if (ready) {
      await SplashScreen.hideAsync();
    }
  }, [ready]);

  if (!ready) {
    return (
      <View style={styles.boot}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.brass} size="large" />
        <Text style={styles.bootText}>악보플레이</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider onLayout={onLayout} style={styles.provider}>
      <View style={styles.appRoot}>
        <RootNavigator />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  provider: {
    flex: 1,
    ...(Platform.OS === 'web'
      ? ({ height: '100%', minHeight: '100vh' } as object)
      : null),
  },
  appRoot: {
    flex: 1,
    ...(Platform.OS === 'web'
      ? ({ height: '100%', minHeight: '100vh' } as object)
      : null),
  },
  boot: {
    flex: 1,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    ...(Platform.OS === 'web' ? ({ height: '100vh' } as object) : null),
  },
  bootText: {
    color: colors.cream,
    fontSize: 18,
    letterSpacing: 1,
  },
});
