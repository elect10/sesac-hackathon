import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as FormData from 'form-data';
import { PrismaService } from '../prisma/prisma.service';
import { AxiosResponse } from 'axios';

@Injectable()
export class ChatService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) { }
  private readonly logger = new Logger(ChatService.name);

  async generateProblem(userId: string) {
    const user = await this.prismaService.users.findUnique({
      where: { id: userId },
    });
    const cur = new Date();
    const birth = new Date(user.birth);
    const month = Math.abs(
      (cur.getFullYear() - birth.getFullYear()) * 12 +
      (cur.getMonth() - birth.getMonth()),
    );

    const solveHistories = await this.prismaService.solveHistories.findMany({
      where: { userId: user.id },
    });

    const answerRate = solveHistories.reduce(
      (acc, cur) => (cur.isCorrect ? acc + 1 : acc),
      0,
    );

    // check and create achievement
    await this.checkAndCreateAchievement(user.id, answerRate);

    // TODO: 기준표 보고 languageLevel 계산하기
    const languageLevel = '초급';

    // TODO: feedback 불러오기
    const parentFeedback = this.prismaService.parentFeedbacks.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { feedback: true, createdAt: true },
    });

    const data = {
      userInfo: {
        age: month,
        accuracy: answerRate,
        interests: user.interest,
        languageLevel: languageLevel,
        languageGoals: null,
        feedback: parentFeedback,
      },
    };

    const url =
      this.configService.get<string>('AI_SERVER_URL') +
      '/chat/generate_problem';

    const response = await firstValueFrom(this.httpService.post(url, data));

    const { id, question, answer, image, image_path, whole_text } =
      response.data.data;

    await this.prismaService.problems.create({
      data: {
        id: id,
        userId: user.id,
        question: question,
        answer: answer,
        imagePath: image_path,
        wholeText: whole_text,
      },
    });

    return {
      problemId: id,
      question,
      image,
    };
  }

  async communicateWithAI(url: string, data: any): Promise<AxiosResponse<any>> {
    try {
      return await firstValueFrom(this.httpService.post(url, data));
    } catch (error) {
      throw new InternalServerErrorException(error.message);
    }
  }

  async generateFeedback(
    problemId: string,
    user: any,
    voice: Express.Multer.File,
  ) {
    const problem = await this.prismaService.problems.findUnique({
      where: { id: problemId, userId: user.id },
      select: { answer: true },
    });

    if (!problem) {
      throw new Error('Problem not found');
    }

    const form = new FormData();
    form.append('problemId', problemId);
    form.append('answer', JSON.stringify(problem.answer));
    form.append('voice', voice.buffer, voice.originalname);

    const headers = {
      ...form.getHeaders(),
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          this.configService.get<string>('AI_SERVER_URL') +
          '/chat/generate_feedback',
          form,
          { headers },
        ),
      );

      this.prismaService.solveHistories.create({
        data: {
          userId: user.id,
          problemId: problemId,
          isCorrect: response.data?.data.is_correct,
          feedback: response.data?.data.feedback,
          voicePath: response.data?.data.voice_path,
        },
      });

      return response.data.data;
    } catch (error) {
      throw new InternalServerErrorException(error.message);
    }
  }

  /*
  checks and creates an achievement if the user is eligible
  criteria:
    1. achieved new highest answer rate (update the old achievement's answer rate if needed)
  */
  private async checkAndCreateAchievement(
    userId: string,
    newAnswerRate: number,
  ) {
    const highestAnsRateAchievement =
      await this.prismaService.userAchievements.findFirst({
        where: { userId },
        include: {
          achievement: true,
        },
        orderBy: {
          achievement: {
            level: 'desc',
          },
        },
      });

    // if the user already has an achievement on highest accuracy
    if (highestAnsRateAchievement) {
      // check if the new answer rate is higher than the current 
      if (newAnswerRate > highestAnsRateAchievement.achievement.level) {
        await this.prismaService.achievements.update({
          where: { id: highestAnsRateAchievement.achievement.id },
          data: {
            title: "Highest Answer Rate",
            description: `정답률 ${(newAnswerRate * 100).toFixed(2)}% 달성`,
            level: newAnswerRate,
          }
        });

        this.logger.log(`Highest Answer Rate achievement updated for user ${userId} to ${newAnswerRate}`);
      }
    }
    // no highest answer rate achievement exists => create one
    else {
      const newHighAnsRateAchievement = await this.prismaService.achievements.create({
        data: {
          title: 'Highest Answer Rate',
          description: `정답률 ${(newAnswerRate * 100).toFixed(2)}% 달성`,
          level: newAnswerRate,
        }
      });

      await this.prismaService.userAchievements.create({
        data: {
          userId: userId,
          achievementId: newHighAnsRateAchievement.id,
        },
      });

      this.logger.log(`Highest Answer Rate achievement created for user ${userId} with answer rate ${newAnswerRate}`);
    }
  }
}
