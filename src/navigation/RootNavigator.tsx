import React from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeScreen } from '../screens/HomeScreen';
import { SongsScreen } from '../screens/SongsScreen';
import { PlaylistScreen } from '../screens/PlaylistScreen';
import { BeatDetectScreen } from '../screens/BeatDetectScreen';
import { TabConvertScreen } from '../screens/TabConvertScreen';
import { colors } from '../theme/colors';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.ink,
    card: colors.inkSoft,
    text: colors.cream,
    border: colors.inkLift,
    primary: colors.brass,
  },
};

export function RootNavigator() {
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.ink },
          headerTintColor: colors.brassBright,
          headerTitleStyle: {
            fontFamily: 'Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif',
            fontSize: 16,
          },
          contentStyle: {
            backgroundColor: colors.ink,
            flex: 1,
          },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Songs"
          component={SongsScreen}
          options={{ title: '곡 확인' }}
        />
        <Stack.Screen
          name="BeatDetect"
          component={BeatDetectScreen}
          options={{ title: 'Tempo' }}
        />
        <Stack.Screen
          name="TabConvert"
          component={TabConvertScreen}
          options={{ title: 'TAB 변환' }}
        />
        <Stack.Screen
          name="Playlist"
          component={PlaylistScreen}
          options={{ title: '플레이리스트' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
